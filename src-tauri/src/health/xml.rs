// A streaming XML element scanner, written for ONE hostile input: the file a
// person exports from the iPhone Health app and hands to Atlas.
//
// WHY THIS EXISTS AT ALL, RATHER THAN A CRATE
// `quick-xml` is in Cargo.lock already, but only as a build-time transitive of
// the Tauri toolchain — making it a dependency of this crate is a Cargo.toml
// edit, and Cargo.toml is pinned by the librespot/vergen constraint recorded in
// docs/decisions/006 and is not this module's to touch. What the importer needs
// from a parser is also unusually small: element names, attribute values, and a
// guarantee that nothing in the file can make the process allocate without
// bound or stop. So this is ~300 lines of state machine rather than a general
// XML implementation, and it says no to most of XML on purpose.
//
// WHAT IT DOES NOT DO, DELIBERATELY
//   * No DTD processing. `<!DOCTYPE …>` — which every Apple export begins with,
//     ~5 KB of it — is SKIPPED, not interpreted. Entity declarations inside it
//     are therefore never defined, and `decode` below refuses any entity
//     reference that is not one of XML's five predefined names or a numeric
//     character reference. That is not a hardening pass bolted on afterwards:
//     it makes XXE and the billion-laughs expansion structurally impossible
//     rather than merely bounded, because there is no code path that can look
//     an entity name up.
//   * No text content. The export puts everything in attributes. Character data
//     between tags is skipped without being buffered, so a 400 MB run of text
//     costs nothing but the time to walk past it.
//   * No namespaces, no XInclude, no external references of any kind. Nothing
//     here opens a file or a socket.
//
// AND THE PROPERTY THAT MATTERS MOST HERE: NOTHING IN THIS FILE PANICS ON
// INPUT. Every failure is an `XmlError`. The health importer is reachable from
// a control worker, and a panic in one used to retire that worker permanently —
// so a malformed byte in a user's export must be a message, never a thread
// death. There is no indexing that can be out of range, no `unwrap` on a parse,
// no recursion (so no stack overflow on a deeply nested document), and every
// growing buffer has a ceiling.

use std::io::Read;

// ---------------------------------------------------------------------------
// Limits — every one of them is a ceiling on memory or time, not a style rule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct XmlLimits {
    /// Longest single tag, in bytes. The number that stops an unterminated `<`
    /// from buffering an entire multi-hundred-megabyte file into one `Vec`.
    pub max_element_bytes: usize,
    /// Longest `<!DOCTYPE …>`/`<!--…-->`/CDATA run. Larger than a tag because a
    /// real Apple export's internal DTD subset is a few KB; still bounded.
    pub max_declaration_bytes: usize,
    /// Attributes on one element.
    pub max_attrs: usize,
    /// Element-name length.
    pub max_name_bytes: usize,
    /// Nesting depth. The scanner keeps one open-tag stack; this bounds it.
    pub max_depth: usize,
    /// Total bytes read from the source.
    pub max_total_bytes: u64,
}

impl Default for XmlLimits {
    fn default() -> Self {
        Self {
            max_element_bytes: 64 * 1024,
            max_declaration_bytes: 1024 * 1024,
            max_attrs: 64,
            max_name_bytes: 256,
            max_depth: 64,
            // 8 GiB. An Apple export is hundreds of MB uncompressed and the
            // largest reported ones are a few GB, so this is a stop for a file
            // that is not an export at all (or a decompression bomb streaming
            // out of the unzip pipe) rather than a limit a real user meets.
            max_total_bytes: 8 * 1024 * 1024 * 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XmlError {
    /// The bytes stopped mid-construct. Distinct from `Malformed` because it is
    /// the signature of a TRUNCATED download, which has a different fix.
    UnexpectedEnd(&'static str),
    /// Well-formedness: the file is not XML, or not this shape of it.
    Malformed(String),
    /// An entity reference this parser refuses to resolve. Its own variant
    /// because it is the one that means "someone may be trying something",
    /// where the others mean "this file is broken".
    ForbiddenEntity(String),
    /// A limit above was hit.
    TooLarge(String),
    /// A name or value was not UTF-8. Apple exports declare UTF-8; anything
    /// else is a file that has been through something.
    NotUtf8,
    /// The underlying reader failed. Carries the message, never the bytes.
    Io(String),
}

impl std::fmt::Display for XmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            XmlError::UnexpectedEnd(what) => {
                write!(f, "the file ends in the middle of {what} — it looks truncated")
            }
            XmlError::Malformed(m) => write!(f, "this is not a readable XML export: {m}"),
            XmlError::ForbiddenEntity(name) => write!(
                f,
                "the file uses the XML entity '&{name};', which Atlas does not resolve"
            ),
            XmlError::TooLarge(m) => write!(f, "the file is larger than Atlas will read: {m}"),
            XmlError::NotUtf8 => write!(f, "the file is not UTF-8 text"),
            XmlError::Io(m) => write!(f, "the file could not be read: {m}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `<Workout …>` — pushes a level.
    Open,
    /// `<Record …/>` — the shape of essentially every element in the export.
    Empty,
    /// `</Workout>`.
    Close,
}

/// The scanner's one reusable element buffer. Owned by the `Scanner` and handed
/// out by shared reference, so scanning ten million records allocates the
/// name/attribute `String`s once each rather than once per record.
#[derive(Debug, Default)]
pub struct Element {
    pub name: String,
    pub kind: Option<Kind>,
    attrs: Vec<(String, String)>,
    /// How many entries of `attrs` belong to the CURRENT element. The vector
    /// itself is never shrunk — that is the point of reusing it.
    used: usize,
    /// Name of the containing element, empty at the document root.
    ///
    /// CARRIED ON THE ELEMENT rather than asked of the scanner, because the
    /// element is handed out as a borrow OF the scanner: a caller holding it
    /// cannot also call a `&self` method on the scanner to ask what contains
    /// it. Copying a short parent name into a reused `String` costs no
    /// allocation after the first element.
    parent: String,
}

impl Element {
    /// The element this one is inside, or `None` at the root. This is what
    /// lets a reader bind a `<WorkoutStatistics/>` to the `<Workout>` it is a
    /// direct child of and ignore an identically-named one nested deeper.
    pub fn parent(&self) -> Option<&str> {
        Some(self.parent.as_str()).filter(|p| !p.is_empty())
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs[..self.used]
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn attr_count(&self) -> usize {
        self.used
    }

    fn reset(&mut self) {
        self.name.clear();
        self.kind = None;
        self.used = 0;
        self.parent.clear();
    }

    fn push_attr(&mut self, key: String, value: String) {
        if self.used < self.attrs.len() {
            self.attrs[self.used] = (key, value);
        } else {
            self.attrs.push((key, value));
        }
        self.used += 1;
    }

    fn has_attr(&self, key: &str) -> bool {
        self.attrs[..self.used].iter().any(|(k, _)| k == key)
    }
}

// ---------------------------------------------------------------------------
// The byte source
// ---------------------------------------------------------------------------

/// A refilling byte reader. Its own type so the scanner below never touches a
/// buffer index, and so `max_total_bytes` is enforced in exactly one place.
struct Bytes<R: Read> {
    src: R,
    buf: Box<[u8]>,
    pos: usize,
    filled: usize,
    total: u64,
    max_total: u64,
    done: bool,
}

impl<R: Read> Bytes<R> {
    fn new(src: R, max_total: u64) -> Self {
        Self {
            src,
            buf: vec![0u8; 64 * 1024].into_boxed_slice(),
            pos: 0,
            filled: 0,
            total: 0,
            max_total,
            done: false,
        }
    }

    fn next_byte(&mut self) -> Result<Option<u8>, XmlError> {
        if self.pos == self.filled {
            if self.done {
                return Ok(None);
            }
            // A short read is not EOF (a pipe from `unzip` hands out whatever
            // has arrived), so loop until a read returns 0 or fills something.
            loop {
                match self.src.read(&mut self.buf) {
                    Ok(0) => {
                        self.done = true;
                        return Ok(None);
                    }
                    Ok(n) => {
                        self.pos = 0;
                        self.filled = n;
                        self.total += n as u64;
                        if self.total > self.max_total {
                            return Err(XmlError::TooLarge(format!(
                                "more than {} bytes of XML",
                                self.max_total
                            )));
                        }
                        break;
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(XmlError::Io(e.to_string())),
                }
            }
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(Some(b))
    }
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

pub struct Scanner<R: Read> {
    bytes: Bytes<R>,
    limits: XmlLimits,
    el: Element,
    /// Raw bytes of the tag currently being read, without `<` or `>`.
    raw: Vec<u8>,
    /// Open element names, innermost last. Bounded by `max_depth`.
    stack: Vec<String>,
    elements: u64,
}

impl<R: Read> Scanner<R> {
    pub fn new(src: R, limits: XmlLimits) -> Self {
        Self {
            bytes: Bytes::new(src, limits.max_total_bytes),
            limits,
            el: Element::default(),
            raw: Vec::with_capacity(1024),
            stack: Vec::new(),
            elements: 0,
        }
    }

    /// The next element, or `None` at end of document.
    ///
    /// The returned reference borrows the scanner, so it is valid until the next
    /// call — the importer copies out the two or three attributes it wants and
    /// moves on, which is why one reusable `Element` is enough.
    pub fn next_element(&mut self) -> Result<Option<&Element>, XmlError> {
        loop {
            // --- walk to the next '<', buffering nothing --------------------
            let mut found = false;
            while let Some(b) = self.bytes.next_byte()? {
                if b == b'<' {
                    found = true;
                    break;
                }
            }
            if !found {
                if !self.stack.is_empty() {
                    // A &'static str: the open element's own name comes from the
                    // file, so it never lands in a message.
                    return Err(XmlError::UnexpectedEnd("an element that was never closed"));
                }
                return Ok(None);
            }

            let Some(first) = self.bytes.next_byte()? else {
                return Err(XmlError::UnexpectedEnd("a tag"));
            };

            match first {
                // <!-- … -->, <![CDATA[ … ]]>, <!DOCTYPE … > — all skipped.
                b'!' => {
                    self.skip_bang()?;
                    continue;
                }
                // <?xml … ?> and any other processing instruction.
                b'?' => {
                    self.skip_until(b"?>")?;
                    continue;
                }
                b'/' => {
                    self.raw.clear();
                    self.read_raw_tag()?;
                    self.finish_close()?;
                }
                _ => {
                    self.raw.clear();
                    self.raw.push(first);
                    self.read_raw_tag()?;
                    self.finish_open()?;
                }
            }
            self.elements += 1;
            return Ok(Some(&self.el));
        }
    }

    /// Read the body of a tag into `self.raw`, stopping at the `>` that is not
    /// inside an attribute value. Quote tracking is the whole job: a `>` inside
    /// `title="a > b"` does not end a tag, and a scanner that thought it did
    /// would silently mis-parse every attribute after it.
    fn read_raw_tag(&mut self) -> Result<(), XmlError> {
        let mut quote: Option<u8> = None;
        loop {
            let Some(b) = self.bytes.next_byte()? else {
                return Err(XmlError::UnexpectedEnd("a tag"));
            };
            match quote {
                Some(q) if b == q => quote = None,
                Some(_) => {}
                None if b == b'"' || b == b'\'' => quote = Some(b),
                None if b == b'>' => return Ok(()),
                None => {}
            }
            if self.raw.len() >= self.limits.max_element_bytes {
                return Err(XmlError::TooLarge(format!(
                    "a single tag longer than {} bytes",
                    self.limits.max_element_bytes
                )));
            }
            self.raw.push(b);
        }
    }

    /// Skip a `<!…>` construct. Three shapes share the prefix, and they end
    /// differently, so the first bytes decide which rule applies.
    fn skip_bang(&mut self) -> Result<(), XmlError> {
        let mut prefix: Vec<u8> = Vec::with_capacity(8);
        while prefix.len() < 8 {
            let Some(b) = self.bytes.next_byte()? else {
                return Err(XmlError::UnexpectedEnd("a declaration"));
            };
            prefix.push(b);
            if prefix.starts_with(b"--") {
                return self.skip_until(b"-->");
            }
            if prefix == b"[CDATA[" {
                return self.skip_until(b"]]>");
            }
            // `<!>` and other degenerate forms end immediately.
            if b == b'>' {
                return Ok(());
            }
        }
        // A DOCTYPE, and the internal subset in brackets is where an Apple
        // export's DTD lives. Skipped to the `>` that closes the declaration,
        // tracking bracket depth and quotes so a `>` inside the subset (there
        // are several, in every export) does not end it early.
        let mut depth = 0i32;
        let mut quote: Option<u8> = None;
        let mut read: usize = prefix.len();
        loop {
            let Some(b) = self.bytes.next_byte()? else {
                return Err(XmlError::UnexpectedEnd("a DOCTYPE declaration"));
            };
            read += 1;
            if read > self.limits.max_declaration_bytes {
                return Err(XmlError::TooLarge(format!(
                    "a declaration longer than {} bytes",
                    self.limits.max_declaration_bytes
                )));
            }
            match quote {
                Some(q) if b == q => quote = None,
                Some(_) => {}
                None => match b {
                    b'"' | b'\'' => quote = Some(b),
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'>' if depth <= 0 => return Ok(()),
                    _ => {}
                },
            }
        }
    }

    /// Skip forward past `end`, buffering only the last `end.len()` bytes.
    fn skip_until(&mut self, end: &[u8]) -> Result<(), XmlError> {
        let mut tail: Vec<u8> = Vec::with_capacity(end.len());
        let mut read: usize = 0;
        loop {
            let Some(b) = self.bytes.next_byte()? else {
                return Err(XmlError::UnexpectedEnd("a comment or declaration"));
            };
            read += 1;
            if read > self.limits.max_declaration_bytes {
                return Err(XmlError::TooLarge(format!(
                    "a comment or declaration longer than {} bytes",
                    self.limits.max_declaration_bytes
                )));
            }
            if tail.len() == end.len() {
                tail.remove(0);
            }
            tail.push(b);
            if tail == end {
                return Ok(());
            }
        }
    }

    /// `</name>` — pop the stack and check it matches.
    fn finish_close(&mut self) -> Result<(), XmlError> {
        self.el.reset();
        self.el.kind = Some(Kind::Close);
        // Taken out of `self` so the name can be read while `self.el` is
        // written, then handed straight back — the buffer is reused, never
        // reallocated per tag.
        let raw = std::mem::take(&mut self.raw);
        let result: Result<(), XmlError> = (|| {
            let name = trim(&raw);
            self.check_name(name)?;
            self.el.name.push_str(as_str(name)?);
            Ok(())
        })();
        self.raw = raw;
        self.raw.clear();
        result?;
        let popped = self.stack.pop();
        // Recorded AFTER the pop, so a close tag reports the element it is
        // nested in rather than the one it closes.
        if let Some(outer) = self.stack.last() {
            self.el.parent.push_str(outer);
        }
        match popped {
            Some(open) if open == self.el.name => Ok(()),
            // Neither branch echoes the name: both strings come from the file.
            Some(_) => Err(XmlError::Malformed(
                "a closing tag does not match the element it closes".into(),
            )),
            None => Err(XmlError::Malformed(
                "a closing tag with no matching opening tag".into(),
            )),
        }
    }

    /// `<name …>` or `<name …/>` — parse the attributes and push if it opens.
    fn finish_open(&mut self) -> Result<(), XmlError> {
        self.el.reset();
        let raw = std::mem::take(&mut self.raw);
        let body = trim(&raw);
        let self_closing = body.last() == Some(&b'/');
        let body = if self_closing { &body[..body.len() - 1] } else { body };
        let result = self.parse_tag(body);
        // Give the buffer back before propagating, or the next tag reallocates.
        self.raw = raw;
        self.raw.clear();
        result?;

        self.el.kind = Some(if self_closing { Kind::Empty } else { Kind::Open });
        // Recorded BEFORE the push, so an opening tag reports what contains it
        // rather than itself.
        if let Some(outer) = self.stack.last() {
            self.el.parent.push_str(outer);
        }
        if !self_closing {
            if self.stack.len() >= self.limits.max_depth {
                return Err(XmlError::TooLarge(format!(
                    "elements nested deeper than {}",
                    self.limits.max_depth
                )));
            }
            self.stack.push(self.el.name.clone());
        }
        Ok(())
    }

    fn parse_tag(&mut self, body: &[u8]) -> Result<(), XmlError> {
        let mut i = 0usize;
        // Name.
        let start = i;
        while i < body.len() && !is_space(body[i]) {
            i += 1;
        }
        let name = &body[start..i];
        self.check_name(name)?;
        self.el.name.push_str(as_str(name)?);

        // Attributes.
        loop {
            while i < body.len() && is_space(body[i]) {
                i += 1;
            }
            if i >= body.len() {
                return Ok(());
            }
            if self.el.attr_count() >= self.limits.max_attrs {
                return Err(XmlError::TooLarge(format!(
                    "more than {} attributes on one element",
                    self.limits.max_attrs
                )));
            }
            let key_start = i;
            while i < body.len() && body[i] != b'=' && !is_space(body[i]) {
                i += 1;
            }
            let key = &body[key_start..i];
            if key.is_empty() {
                return Err(XmlError::Malformed("an attribute with no name".into()));
            }
            self.check_name(key)?;
            while i < body.len() && is_space(body[i]) {
                i += 1;
            }
            if i >= body.len() || body[i] != b'=' {
                return Err(XmlError::Malformed(
                    "an attribute with no '=' after its name".into(),
                ));
            }
            i += 1;
            while i < body.len() && is_space(body[i]) {
                i += 1;
            }
            // UNQUOTED VALUES ARE REFUSED, not tolerated. They are illegal XML,
            // and "guess where it ends" is how a parser and the thing that
            // wrote the file end up disagreeing about where a value stops.
            let quote = match body.get(i) {
                Some(&q @ (b'"' | b'\'')) => q,
                _ => {
                    return Err(XmlError::Malformed(
                        "an attribute value that is not quoted".into(),
                    ))
                }
            };
            i += 1;
            let val_start = i;
            while i < body.len() && body[i] != quote {
                i += 1;
            }
            if i >= body.len() {
                return Err(XmlError::UnexpectedEnd("an attribute value"));
            }
            let value = decode(&body[val_start..i])?;
            i += 1;

            let key = as_str(key)?.to_string();
            // A repeated attribute is not well-formed XML, and picking one of
            // the two is precisely how a reader and a writer are made to
            // disagree about what a document says.
            if self.el.has_attr(&key) {
                return Err(XmlError::Malformed(
                    "the same attribute appears twice on one element".into(),
                ));
            }
            self.el.push_attr(key, value);
        }
    }

    fn check_name(&self, name: &[u8]) -> Result<(), XmlError> {
        if name.is_empty() {
            return Err(XmlError::Malformed("a tag with no name".into()));
        }
        if name.len() > self.limits.max_name_bytes {
            return Err(XmlError::TooLarge(format!(
                "a name longer than {} bytes",
                self.limits.max_name_bytes
            )));
        }
        Ok(())
    }
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

fn trim(raw: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = raw.len();
    while start < end && is_space(raw[start]) {
        start += 1;
    }
    while end > start && is_space(raw[end - 1]) {
        end -= 1;
    }
    &raw[start..end]
}

fn as_str(raw: &[u8]) -> Result<&str, XmlError> {
    std::str::from_utf8(raw).map_err(|_| XmlError::NotUtf8)
}

/// Resolve the ONLY entity references this parser knows: XML's five predefined
/// names and numeric character references.
///
/// Everything else is `ForbiddenEntity`. There is deliberately no table to add
/// to and no DTD to consult — see the module header. `&` with no `;` within a
/// short window is also refused rather than passed through literally, because
/// "pass it through" is how a parser and a writer end up with different strings.
fn decode(raw: &[u8]) -> Result<String, XmlError> {
    let text = as_str(raw)?;
    if !text.contains('&') {
        return Ok(text.to_string());
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        // 12 is longer than every form this accepts (`#x10FFFF` is 8), so a
        // stray `&` in prose cannot make this scan to the end of the value.
        let limit = after.len().min(12);
        let Some(semi) = after[..limit].find(';') else {
            return Err(XmlError::ForbiddenEntity("…".into()));
        };
        let name = &after[..semi];
        let ch = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse::<u32>().ok()
                } else {
                    None
                };
                match code.and_then(char::from_u32) {
                    Some(c) => c,
                    // The name is echoed here and nowhere else, and only after
                    // being bounded to 12 chars above.
                    None => return Err(XmlError::ForbiddenEntity(name.to_string())),
                }
            }
        };
        out.push(ch);
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (name, kind, attributes) for every element in a document.
    type Scanned = Vec<(String, Kind, Vec<(String, String)>)>;

    fn scan(src: &str) -> Result<Scanned, XmlError> {
        let mut s = Scanner::new(src.as_bytes(), XmlLimits::default());
        let mut out = Vec::new();
        while let Some(el) = s.next_element()? {
            out.push((
                el.name.clone(),
                el.kind.expect("every emitted element has a kind"),
                el.attrs[..el.used].to_vec(),
            ));
        }
        Ok(out)
    }

    #[test]
    fn it_reads_the_shape_an_apple_export_is_made_of() {
        let out = scan(
            r#"<?xml version="1.0" encoding="UTF-8"?>
               <!DOCTYPE HealthData [ <!ELEMENT HealthData (Record*)> ]>
               <HealthData locale="da_DK">
                 <Record type="HKQuantityTypeIdentifierStepCount" value="812"/>
               </HealthData>"#,
        )
        .expect("a well-formed export");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].0, "HealthData");
        assert_eq!(out[0].1, Kind::Open);
        assert_eq!(out[1].0, "Record");
        assert_eq!(out[1].1, Kind::Empty);
        assert_eq!(out[1].2[1], ("value".into(), "812".into()));
        assert_eq!(out[2].1, Kind::Close);
    }

    /// The DOCTYPE an export really carries contains `>` inside its internal
    /// subset. A skipper that stopped at the first one would resume parsing in
    /// the middle of a DTD and report garbage elements.
    #[test]
    fn a_doctype_with_angle_brackets_inside_it_is_skipped_whole() {
        let out = scan(
            r#"<!DOCTYPE HealthData [
                 <!ELEMENT HealthData (ExportDate,Record*)>
                 <!ATTLIST Record type CDATA #REQUIRED>
               ]>
               <HealthData/>"#,
        )
        .expect("a real export's DTD");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "HealthData");
    }

    /// The XXE / billion-laughs guard, stated as behaviour rather than as a
    /// comment: an entity the DTD "defines" is never resolved, because there is
    /// no code that can look one up.
    #[test]
    fn an_entity_the_dtd_declares_is_refused_rather_than_expanded() {
        let err = scan(
            r#"<!DOCTYPE HealthData [
                 <!ENTITY lol "haha">
                 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">
               ]>
               <HealthData locale="&lol2;"/>"#,
        )
        .expect_err("a declared entity must not resolve");
        assert_eq!(err, XmlError::ForbiddenEntity("lol2".into()));

        // And the classic external one, which is the file-read primitive.
        let err = scan(r#"<HealthData locale="&xxe;"/>"#).expect_err("no external entities");
        assert!(matches!(err, XmlError::ForbiddenEntity(_)), "{err:?}");
    }

    #[test]
    fn the_five_predefined_entities_and_numeric_refs_do_resolve() {
        let out = scan(r#"<R a="a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;"/>"#)
            .expect("predefined entities");
        assert_eq!(out[0].2[0].1, r#"a&b <c> "d" 'e' AB"#);
    }

    #[test]
    fn an_unterminated_tag_is_an_error_not_a_hang() {
        let err = scan("<HealthData><Record type=\"x\"").expect_err("truncated");
        assert_eq!(err, XmlError::UnexpectedEnd("a tag"));
    }

    /// A truncated download stops mid-document with elements still open. That
    /// has to be an error: silently treating it as a complete file would make
    /// Atlas import half a year and report it as a whole one.
    #[test]
    fn a_document_that_ends_with_elements_open_is_refused() {
        let err = scan("<HealthData><Record type=\"x\"/>").expect_err("unclosed root");
        assert_eq!(err, XmlError::UnexpectedEnd("an element that was never closed"));
    }

    #[test]
    fn a_mismatched_closing_tag_is_refused() {
        let err = scan("<A><B/></C>").expect_err("mismatched");
        assert!(matches!(err, XmlError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn an_unquoted_or_duplicated_attribute_is_refused() {
        assert!(matches!(
            scan("<R a=1/>").expect_err("unquoted"),
            XmlError::Malformed(_)
        ));
        assert!(matches!(
            scan(r#"<R a="1" a="2"/>"#).expect_err("duplicated"),
            XmlError::Malformed(_)
        ));
    }

    /// A `>` inside an attribute value must not end the tag.
    #[test]
    fn an_angle_bracket_inside_a_value_does_not_end_the_tag() {
        let out = scan(r#"<R name="a > b" unit="count"/>"#).expect("quoted >");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].2[0].1, "a > b");
        assert_eq!(out[0].2[1].1, "count");
    }

    /// The ceiling that keeps an unterminated `<` from buffering a whole file.
    #[test]
    fn an_absurdly_long_tag_stops_instead_of_being_buffered() {
        let limits = XmlLimits { max_element_bytes: 128, ..XmlLimits::default() };
        let src = format!("<R name=\"{}\"/>", "x".repeat(4096));
        let mut s = Scanner::new(src.as_bytes(), limits);
        let err = s.next_element().expect_err("must refuse");
        assert!(matches!(err, XmlError::TooLarge(_)), "{err:?}");
    }

    #[test]
    fn nesting_is_bounded() {
        let limits = XmlLimits { max_depth: 4, ..XmlLimits::default() };
        let src = "<a><a><a><a><a><a/></a></a></a></a></a>";
        let mut s = Scanner::new(src.as_bytes(), limits);
        let err = loop {
            match s.next_element() {
                Ok(Some(_)) => continue,
                Ok(None) => panic!("deep nesting was accepted"),
                Err(e) => break e,
            }
        };
        assert!(matches!(err, XmlError::TooLarge(_)), "{err:?}");
    }

    /// Text and comments between elements are walked past, not buffered, and
    /// CDATA is not mistaken for markup.
    #[test]
    fn text_comments_and_cdata_are_skipped() {
        let out = scan(
            "<A>plain text<!-- a comment with <tags> in it --><![CDATA[<B/>]]><C/></A>",
        )
        .expect("skippable content");
        let names: Vec<&str> = out.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(names, ["A", "C", "A"]);
    }

    /// The importer needs to tell a `<WorkoutStatistics/>` that is a direct
    /// child of a workout from one buried inside a `<WorkoutRoute>`.
    #[test]
    fn parent_names_the_containing_element() {
        let mut s = Scanner::new(
            "<HealthData><Workout><WorkoutStatistics/><WorkoutRoute><WorkoutStatistics/></WorkoutRoute></Workout></HealthData>".as_bytes(),
            XmlLimits::default(),
        );
        let mut seen: Vec<(String, Option<String>)> = Vec::new();
        while let Some(el) = s.next_element().expect("well formed") {
            if el.kind == Some(Kind::Empty) || el.kind == Some(Kind::Open) {
                seen.push((el.name.clone(), el.parent().map(str::to_string)));
            }
        }
        assert_eq!(seen[0], ("HealthData".into(), None));
        assert_eq!(seen[1], ("Workout".into(), Some("HealthData".into())));
        assert_eq!(seen[2], ("WorkoutStatistics".into(), Some("Workout".into())));
        assert_eq!(seen[4], ("WorkoutStatistics".into(), Some("WorkoutRoute".into())));
    }

    /// An empty file is not an error and not a document — it is zero elements.
    /// The importer turns that into "this file contained no health records",
    /// which is the sentence the user needs.
    #[test]
    fn an_empty_file_yields_no_elements() {
        assert_eq!(scan("").expect("empty is not malformed").len(), 0);
        assert_eq!(scan("   \n\t ").expect("whitespace only").len(), 0);
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_panic() {
        let src: Vec<u8> = b"<R name=\"\xff\xfe\"/>".to_vec();
        let mut s = Scanner::new(src.as_slice(), XmlLimits::default());
        assert_eq!(s.next_element().expect_err("not utf-8"), XmlError::NotUtf8);
    }

    /// The reusable attribute buffer must not leak the previous element's
    /// attributes into the next one — the bug that shape of optimisation
    /// invites, and the one that would silently attribute one record's value to
    /// the record after it.
    #[test]
    fn a_reused_element_buffer_never_shows_the_previous_elements_attributes() {
        let mut s = Scanner::new(
            r#"<A><R type="a" value="1" unit="count"/><R type="b"/></A>"#.as_bytes(),
            XmlLimits::default(),
        );
        s.next_element().expect("A").expect("A");
        let first = s.next_element().expect("first R").expect("first R");
        assert_eq!(first.attr("value"), Some("1"));
        assert_eq!(first.attr_count(), 3);
        let second = s.next_element().expect("second R").expect("second R");
        assert_eq!(second.attr("type"), Some("b"));
        assert_eq!(second.attr("value"), None, "a stale attribute survived reset");
        assert_eq!(second.attr("unit"), None);
        assert_eq!(second.attr_count(), 1);
    }
}

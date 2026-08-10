// Getting `export.xml` out of what the user actually hands us.
//
// WHAT THE USER ACTUALLY HANDS US
// The iPhone Health app's "Export All Health Data" produces `export.zip` — an
// archive whose useful member is `apple_health_export/export.xml`, alongside an
// `export_cda.xml` (clinical documents, a different schema), and often thousands
// of per-workout GPX routes. So the importer has to take a zip. It also takes a
// bare `export.xml`, because the first thing anyone debugging an import does is
// unzip it by hand.
//
// WHY A SUBPROCESS RATHER THAN A ZIP CRATE
// `zip` and `flate2` are both in Cargo.lock — as build-time transitives of the
// Tauri toolchain, not as dependencies of this crate. Making either a real
// dependency is a Cargo.toml edit, and this module does not own Cargo.toml (the
// vergen pin in docs/decisions/006 is why that file is edited surgically or not
// at all). Hand-writing an INFLATE decoder was the other option and was
// rejected: a wrong bit in a Huffman table is a silently corrupted year of
// someone's health data, and there is no published test vector set that would
// make "it decompressed" mean "it decompressed correctly".
//
// So: `/usr/bin/unzip -p`, which macOS has shipped since forever (Info-ZIP 6.00,
// present on 26.3), streaming to stdout. This is the same shell-out shape the
// smart-home module already uses for the Keychain (`security add-generic-
// password`). THE STRUCTURAL PROPERTY THAT MAKES IT SAFE: `-p` writes the
// member to stdout and nothing to the filesystem, so the zip-slip class of bug
// — an archive entry named `../../../../Library/LaunchAgents/x.plist` — has no
// mechanism here at all. There is no extraction directory to escape from.
//
// IF THIS EVER NEEDS TO BE IN-PROCESS, the seam is `open()`: it returns a
// `Read`, and swapping the subprocess for a zip crate changes this file only.
//
// UNVERIFIED, STATED PLAINLY: the version of `unzip` on this Mac was checked by
// hand (`unzip -v` → Info-ZIP 6.00, Apple-modified). The tests below build real
// zip archives byte-by-byte and run them through the real binary, so the wiring
// IS exercised — but only for STORED (uncompressed) members, because a test
// fixture cannot construct a DEFLATE stream without the compressor this module
// declined to add. The deflate path is what a real export uses and it is the
// one thing here no test covers.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Where `unzip` lives. An absolute path, not a PATH lookup: this is a
/// subprocess spawn inside a desktop app, and resolving it through the
/// environment would let anything that can set `PATH` for this process choose
/// what runs.
const UNZIP: &str = "/usr/bin/unzip";

/// Ceiling on the archive listing we read before choosing a member. An export
/// with thousands of workout routes is normal; an archive whose table of
/// contents is megabytes of names is not an export.
const MAX_LISTING_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError {
    /// The path could not be opened or read.
    Io(String),
    /// The file is neither XML nor a zip archive.
    NotAnExport(String),
    /// A zip, but without the member an export must contain.
    NoExportXml,
    /// The member name in the archive is one this module will not pass to
    /// `unzip` — see `member_is_safe`.
    UnsafeMember,
    /// `unzip` itself failed, or stopped early.
    Extract(String),
}

impl std::fmt::Display for ZipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ZipError::Io(m) => write!(f, "the file could not be opened: {m}"),
            ZipError::NotAnExport(m) => write!(
                f,
                "this is not an Apple Health export ({m}). Export yours from the \
                 Health app on iPhone: your profile picture, then Export All Health Data."
            ),
            ZipError::NoExportXml => write!(
                f,
                "this zip has no export.xml in it, so it is not a Health export. \
                 Health exports contain apple_health_export/export.xml."
            ),
            ZipError::UnsafeMember => write!(
                f,
                "this archive names its export.xml in a way Atlas will not extract"
            ),
            ZipError::Extract(m) => write!(f, "the export could not be unpacked: {m}"),
        }
    }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/// A readable `export.xml`, and the subprocess feeding it if there is one.
pub struct ExportStream {
    reader: Box<dyn Read + Send>,
    child: Option<Child>,
    /// What the stream is called, for the sync-state row. The archive's own
    /// file name, never a path from inside the archive.
    pub label: String,
    pub bytes: Option<u64>,
}

/// Hand-written because `Box<dyn Read>` is not `Debug`. It names the archive
/// and whether a subprocess is feeding it, and nothing about the CONTENT —
/// which is health data, and has no business in a debug line.
impl std::fmt::Debug for ExportStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExportStream")
            .field("label", &self.label)
            .field("bytes", &self.bytes)
            .field("unzipped", &self.child.is_some())
            .finish()
    }
}

impl ExportStream {
    pub fn reader(&mut self) -> &mut dyn Read {
        &mut self.reader
    }

    /// Wait for the extractor and confirm it finished cleanly.
    ///
    /// THIS IS NOT HOUSEKEEPING. A pipe that ends early — a truncated archive, a
    /// CRC mismatch, `unzip` killed — looks EXACTLY like a well-formed document
    /// that stops at a `</HealthData>`… except it does not have one, which the
    /// scanner catches, and except when the truncation lands on an element
    /// boundary, which it would not. Checking the exit status is what turns
    /// "imported 3 months of a 5-year export" from a silent success into an
    /// error. Call it after reading to EOF and before believing the result.
    pub fn finish(mut self) -> Result<(), ZipError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        match child.wait() {
            // Info-ZIP: 0 is the only clean outcome. 1 means "finished, but
            // skipped something", which for a single named member means the
            // member was not fully written — not a warning we can accept.
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(ZipError::Extract(format!(
                "unzip exited with status {}",
                status.code().unwrap_or(-1)
            ))),
            Err(e) => Err(ZipError::Extract(e.to_string())),
        }
    }
}

impl Drop for ExportStream {
    fn drop(&mut self) {
        // An import that bailed early (a limit, a malformed record) leaves
        // `unzip` mid-file with a full pipe. Killing it is what keeps a failed
        // import from leaving a process behind for the life of the app.
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// Open the export at `path`, unpacking it if it is a zip.
pub fn open(path: &Path) -> Result<ExportStream, ZipError> {
    // Canonicalise FIRST. It resolves the path to an absolute one, which means
    // the string handed to `unzip` can never begin with `-` and be read as an
    // option — and it fails cleanly here, with our message, if the file is gone.
    let path: PathBuf = std::fs::canonicalize(path).map_err(|e| ZipError::Io(e.to_string()))?;
    let label = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".to_string());
    let meta = std::fs::metadata(&path).map_err(|e| ZipError::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(ZipError::NotAnExport("it is a folder, not a file".into()));
    }
    let bytes = Some(meta.len());

    let mut head = [0u8; 8];
    let read = {
        let mut f = std::fs::File::open(&path).map_err(|e| ZipError::Io(e.to_string()))?;
        read_head(&mut f, &mut head)?
    };

    match classify(&head[..read]) {
        Container::Xml => {
            let f = std::fs::File::open(&path).map_err(|e| ZipError::Io(e.to_string()))?;
            Ok(ExportStream { reader: Box::new(f), child: None, label, bytes })
        }
        Container::Zip => {
            let member = pick_member(&list_members(&path)?)?;
            let child = spawn_unzip(&path, &member)?;
            open_from_child(child, label, bytes)
        }
        Container::Unknown => Err(ZipError::NotAnExport(
            "it is neither a zip archive nor an XML file".into(),
        )),
    }
}

fn open_from_child(mut child: Child, label: String, bytes: Option<u64>) -> Result<ExportStream, ZipError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ZipError::Extract("unzip produced no output stream".into()))?;
    Ok(ExportStream { reader: Box::new(stdout), child: Some(child), label, bytes })
}

fn read_head(f: &mut std::fs::File, head: &mut [u8; 8]) -> Result<usize, ZipError> {
    let mut filled = 0usize;
    while filled < head.len() {
        match f.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(ZipError::Io(e.to_string())),
        }
    }
    Ok(filled)
}

#[derive(Debug, PartialEq, Eq)]
enum Container {
    Xml,
    Zip,
    Unknown,
}

/// Decide from the first bytes, not from the extension.
///
/// The extension is what the user's Finder shows, and it is routinely wrong —
/// Safari saves `export.zip` as `export.zip.download`, and people rename things.
/// The magic number is what the file IS.
fn classify(head: &[u8]) -> Container {
    // "PK\x03\x04" local header, "PK\x05\x06" an empty archive's EOCD.
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return Container::Zip;
    }
    // A UTF-8 BOM in front of the declaration is legal and does happen.
    let head = head.strip_prefix(b"\xef\xbb\xbf".as_slice()).unwrap_or(head);
    let leading = head
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        .unwrap_or(head.len());
    if head.get(leading) == Some(&b'<') {
        return Container::Xml;
    }
    Container::Unknown
}

/// Every entry name in the archive, via `unzip -Z1` (zipinfo, names only).
fn list_members(path: &Path) -> Result<Vec<String>, ZipError> {
    let mut child = Command::new(UNZIP)
        .arg("-Z1")
        .arg(path)
        .stdout(Stdio::piped())
        // Discarded, not captured: unzip's diagnostics quote names taken from
        // the archive, and an error message is a string this app shows to a
        // person and sometimes hands to a model.
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| ZipError::Extract(format!("could not run unzip: {e}")))?;

    let mut text = String::new();
    if let Some(out) = child.stdout.take() {
        // Bounded read, so an archive with a pathological table of contents
        // cannot make this allocate without limit.
        let _ = out.take(MAX_LISTING_BYTES).read_to_string(&mut text);
    }
    let status = child.wait().map_err(|e| ZipError::Extract(e.to_string()))?;
    if !status.success() {
        return Err(ZipError::Extract(
            "the archive could not be listed — it may be damaged or password-protected".into(),
        ));
    }
    Ok(text.lines().map(str::to_string).collect())
}

/// Choose the export member from an archive's entry names.
///
/// Pure, so the choice is testable without an archive. `export_cda.xml` is the
/// trap this exists for: it sits next to `export.xml` in every Health export,
/// ends in `.xml`, and is a completely different schema — a suffix match would
/// pick it roughly half the time depending on entry order, and the importer
/// would then report zero records from a file full of data.
fn pick_member(names: &[String]) -> Result<String, ZipError> {
    let mut best: Option<&String> = None;
    for name in names {
        if name.rsplit('/').next() != Some("export.xml") {
            continue;
        }
        // Shallowest wins: `apple_health_export/export.xml` over anything
        // nested deeper, so a crafted archive cannot shadow the real one by
        // being listed first.
        // `map_or`, not `is_none_or`: this crate's MSRV is 1.77.2 (Cargo.toml)
        // and `Option::is_none_or` is stable only from 1.82.
        if best.map_or(true, |b| name.matches('/').count() < b.matches('/').count()) {
            best = Some(name);
        }
    }
    let member = best.ok_or(ZipError::NoExportXml)?;
    if !member_is_safe(member) {
        return Err(ZipError::UnsafeMember);
    }
    Ok(member.clone())
}

/// May this entry name be passed to `unzip` as a member argument?
///
/// `unzip` takes its member list as SHELL-STYLE PATTERNS, not literal names:
/// `*`, `?`, `[…]` and `\` all have meaning. An archive entry called
/// `apple_health_export/*.xml` would therefore extract more than one member
/// into our stdin. And a name starting with `-` would be read as an option.
///
/// REFUSED RATHER THAN ESCAPED. Escaping would mean re-implementing Info-ZIP's
/// pattern rules from the outside and being right about them; refusing costs a
/// real user nothing, because the name a real export uses is
/// `apple_health_export/export.xml`.
fn member_is_safe(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains(['*', '?', '[', ']', '\\', '\0', '\n', '\r'])
}

fn spawn_unzip(path: &Path, member: &str) -> Result<Child, ZipError> {
    Command::new(UNZIP)
        // -p: write the member to stdout, extract nothing to disk.
        .arg("-p")
        .arg(path)
        .arg(member)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| ZipError::Extract(format!("could not run unzip: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // -----------------------------------------------------------------------
    // A zip archive, built byte by byte
    //
    // Only STORED (method 0) members, which is all a fixture needs and all this
    // crate could produce — see the module header's note about deflate.
    // -----------------------------------------------------------------------

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    fn le16(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }
    fn le32(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }

    /// Write a zip with the given (name, contents) entries, all stored.
    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();
        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let n = name.as_bytes();
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&le16(20)); // version needed
            out.extend_from_slice(&le16(0)); // flags
            out.extend_from_slice(&le16(0)); // method: stored
            out.extend_from_slice(&le16(0)); // time
            out.extend_from_slice(&le16(0)); // date
            out.extend_from_slice(&le32(crc));
            out.extend_from_slice(&le32(data.len() as u32));
            out.extend_from_slice(&le32(data.len() as u32));
            out.extend_from_slice(&le16(n.len() as u16));
            out.extend_from_slice(&le16(0)); // extra len
            out.extend_from_slice(n);
            out.extend_from_slice(data);

            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&le16(20)); // version made by
            central.extend_from_slice(&le16(20)); // version needed
            central.extend_from_slice(&le16(0));
            central.extend_from_slice(&le16(0));
            central.extend_from_slice(&le16(0));
            central.extend_from_slice(&le16(0));
            central.extend_from_slice(&le32(crc));
            central.extend_from_slice(&le32(data.len() as u32));
            central.extend_from_slice(&le32(data.len() as u32));
            central.extend_from_slice(&le16(n.len() as u16));
            central.extend_from_slice(&le16(0)); // extra
            central.extend_from_slice(&le16(0)); // comment
            central.extend_from_slice(&le16(0)); // disk
            central.extend_from_slice(&le16(0)); // internal attrs
            central.extend_from_slice(&le32(0)); // external attrs
            central.extend_from_slice(&le32(offset));
            central.extend_from_slice(n);
        }
        let central_offset = out.len() as u32;
        let central_len = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(&le16(entries.len() as u16));
        out.extend_from_slice(&le16(entries.len() as u16));
        out.extend_from_slice(&le32(central_len));
        out.extend_from_slice(&le32(central_offset));
        out.extend_from_slice(&le16(0));
        let mut f = std::fs::File::create(path).expect("fixture path is writable");
        f.write_all(&out).expect("fixture written");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-health-zip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join(name)
    }

    fn read_all(mut s: ExportStream) -> String {
        let mut text = String::new();
        s.reader().read_to_string(&mut text).expect("readable");
        s.finish().expect("unzip finished cleanly");
        text
    }

    // -----------------------------------------------------------------------

    /// The whole point of the file: the export's XML comes out of a real zip,
    /// through the real binary.
    #[test]
    fn an_export_zip_streams_its_export_xml() {
        let path = scratch("export.zip");
        write_zip(
            &path,
            &[
                ("apple_health_export/export_cda.xml", b"<ClinicalDocument/>"),
                ("apple_health_export/export.xml", b"<HealthData locale=\"da_DK\"/>"),
                ("apple_health_export/workout-routes/route_1.gpx", b"<gpx/>"),
            ],
        );
        let stream = open(&path).expect("a readable export zip");
        assert_eq!(stream.label, "export.zip");
        assert_eq!(read_all(stream), "<HealthData locale=\"da_DK\"/>");
    }

    /// `export_cda.xml` is a different schema that lives in the same archive.
    /// Picking it would make the importer report zero records from a file full
    /// of them, with no error anywhere to explain it.
    #[test]
    fn the_clinical_document_is_never_mistaken_for_the_export() {
        let names: Vec<String> = ["apple_health_export/export_cda.xml".to_string()].into();
        assert_eq!(pick_member(&names), Err(ZipError::NoExportXml));

        let names: Vec<String> = [
            "apple_health_export/export_cda.xml".to_string(),
            "apple_health_export/export.xml".to_string(),
        ]
        .into();
        assert_eq!(pick_member(&names).unwrap(), "apple_health_export/export.xml");
    }

    /// A crafted archive must not be able to shadow the real export by listing
    /// a deeper one first.
    #[test]
    fn the_shallowest_export_xml_wins() {
        let names: Vec<String> = [
            "a/b/c/d/export.xml".to_string(),
            "apple_health_export/export.xml".to_string(),
        ]
        .into();
        assert_eq!(pick_member(&names).unwrap(), "apple_health_export/export.xml");
    }

    /// `unzip` reads its member list as patterns and its first argument as
    /// options. Both are refused rather than escaped.
    #[test]
    fn a_member_name_that_is_a_pattern_or_an_option_is_refused() {
        for hostile in [
            "-x/export.xml",
            "*/export.xml",
            "a?b/export.xml",
            "a[bc]/export.xml",
            "a\\b/export.xml",
        ] {
            assert!(!member_is_safe(hostile), "{hostile} was accepted");
            let names: Vec<String> = [hostile.to_string()].into();
            assert_eq!(pick_member(&names), Err(ZipError::UnsafeMember), "{hostile}");
        }
        assert!(member_is_safe("apple_health_export/export.xml"));
    }

    /// A bare export.xml is what everybody debugging an import actually has.
    #[test]
    fn a_plain_xml_file_is_read_directly_with_no_subprocess() {
        let path = scratch("export.xml");
        std::fs::write(&path, "<HealthData/>").expect("fixture");
        let stream = open(&path).expect("a plain xml export");
        assert!(stream.child.is_none(), "a plain file must not spawn unzip");
        assert_eq!(read_all(stream), "<HealthData/>");
    }

    /// The container is decided by the bytes, because the extension is decided
    /// by whatever last renamed the file.
    #[test]
    fn the_container_is_decided_by_the_first_bytes_not_the_extension() {
        assert_eq!(classify(b"PK\x03\x04rest"), Container::Zip);
        assert_eq!(classify(b"PK\x05\x06\0\0"), Container::Zip);
        assert_eq!(classify(b"<?xml ve"), Container::Xml);
        assert_eq!(classify(b"\xef\xbb\xbf<?xml"), Container::Xml);
        assert_eq!(classify(b"\n\n  <He"), Container::Xml);
        assert_eq!(classify(b"%PDF-1.7"), Container::Unknown);
        assert_eq!(classify(b""), Container::Unknown);
    }

    #[test]
    fn a_file_that_is_not_an_export_is_refused_by_name() {
        let path = scratch("notes.pdf");
        std::fs::write(&path, b"%PDF-1.7 not health data").expect("fixture");
        let err = open(&path).expect_err("a PDF is not an export");
        assert!(matches!(err, ZipError::NotAnExport(_)), "{err:?}");
        // The message has to tell the user where a real export comes from.
        assert!(err.to_string().contains("Export All Health Data"), "{err}");
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        let err = open(&scratch("nothing-here.zip")).expect_err("no such file");
        assert!(matches!(err, ZipError::Io(_)), "{err:?}");
    }

    /// A zip that is not a Health export at all.
    #[test]
    fn a_zip_without_an_export_xml_says_so() {
        let path = scratch("holiday.zip");
        write_zip(&path, &[("photos/beach.jpg", b"not xml")]);
        assert_eq!(open(&path).expect_err("no export.xml"), ZipError::NoExportXml);
    }

    /// `finish()` is the check that stops a truncated archive being imported as
    /// a short-but-complete one. A corrupt stored member fails its CRC, `unzip`
    /// exits non-zero, and that has to reach the caller.
    #[test]
    fn a_corrupt_member_makes_finish_fail_rather_than_import_a_fragment() {
        let path = scratch("corrupt.zip");
        write_zip(&path, &[("apple_health_export/export.xml", b"<HealthData/>")]);
        // Flip a byte of the member's DATA, leaving the stored CRC pointing at
        // the original — exactly what a half-finished download looks like.
        let mut bytes = std::fs::read(&path).expect("fixture readable");
        let at = bytes
            .windows(12)
            .position(|w| w == b"<HealthData/")
            .expect("the member body is in there");
        bytes[at + 1] = b'X';
        std::fs::write(&path, &bytes).expect("fixture rewritten");

        let mut stream = open(&path).expect("the archive still lists");
        let mut text = String::new();
        let _ = stream.reader().read_to_string(&mut text);
        let err = stream.finish().expect_err("a CRC failure must not pass as success");
        assert!(matches!(err, ZipError::Extract(_)), "{err:?}");
    }
}

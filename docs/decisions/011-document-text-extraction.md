# ADR 011 — Extracting text from assignment documents (Atlas School)

**Status:** accepted (spike findings) · **Date:** 2026-08-11
**Precedent:** `src-tauri/src/health/zip.rs` — the "shell out to a first-party binary
instead of adding a crate" decision, and the lockfile discipline behind it
(`src-tauri/Cargo.toml:85,108`, ADR 006).
**Related:** [010-objc2-wifi-bluetooth-resolution.md](010-objc2-wifi-bluetooth-resolution.md)
— the same lockfile experiment covers `objc2-pdf-kit`.

## Verdict

| Question | Verdict |
| --- | --- |
| `textutil` for `.docx` / `.doc` / `.rtf` / `.html` / `.txt` / `.odt` | **GO WITH CAVEAT** — flawless output, but it **exits 0 on every failure, including on garbage** |
| PDF via a **Rust crate** (`pdf-extract` etc.) | **NO-GO** — nothing PDF-capable is in `Cargo.lock`; a real new tree, for a job the OS already does |
| PDF via **`objc2-pdf-kit`** | **GO** — +1 package, no version moves, works off the main thread, verified end-to-end |
| PDF via a **`/usr/bin` shell-out** | **NO-GO** — macOS 26.3 ships no tool that extracts PDF text. Every candidate was tested and every one failed |
| Detecting a **scanned / image-only PDF** | **GO** — PDFKit returns exactly **0 bytes**, not garbage. Honest failure is available |

The headline: the `zip.rs` shell-out precedent is the right answer for *everything except
PDF*, and for PDF it is not available at all — macOS has no `pdftotext`. PDF has to be a
linked framework, and `objc2-pdf-kit` is the cheapest way to link it.

---

## 1. `textutil` — GO WITH CAVEAT

`/usr/bin/textutil` ships on macOS 26.3 and reads/writes
`txt, rtf, rtfd, html, doc, docx, odt, wordml, webarchive`. It can also *write* `docx`,
which is how the fixtures were made.

**The invocation:**

```
/usr/bin/textutil -convert txt -stdout -encoding UTF-8 <file>
```

Verified against real fixtures — including six genuine Word-produced `.docx` files (10–14
`word/` zip members, versus the 8 textutil itself emits), so this is not a
textutil-reading-its-own-output result:

```
sample.docx    exit=0 bytes=431 stderr=[] danish-lines-matched=2
sample.rtf     exit=0 bytes=431 stderr=[] danish-lines-matched=2
sample.html    exit=0 bytes=263 stderr=[] danish-lines-matched=3
sample.txt     exit=0 bytes=431 stderr=[] danish-lines-matched=2
legacy.doc     exit=0 bytes=431 stderr=[] danish-lines-matched=2
```

`æøå ÆØÅ`, em dashes, ellipses and smart quotes all survive. HTML conversion drops
`<script>`/`<style>` bodies and renders `<ul>` as tab-bulleted lines. Cost is ~30 ms per
document — cheap enough to run inline.

### The caveat, and it is the important half of this section

**`textutil` exits 0 no matter what happens.** Three distinct failures, one exit code:

| input | exit | stdout | stderr |
| --- | --- | --- | --- |
| valid `.docx` | 0 | 431 bytes of real text | *(empty)* |
| truncated `.docx` | 0 | **0 bytes** | `Error reading half.docx.  The file "half.docx" couldn't be opened.` |
| nonexistent file | 0 | **0 bytes** | `Error reading nope.docx.  The file doesn't exist.` |
| **8 KB of random bytes** | 0 | **13,351 bytes of mojibake** | ***(empty)*** |

The last row is the one that will ship a bug. Random binary is decoded as MacRoman and
re-emitted as perfectly valid UTF-8 nonsense, with a clean exit and a silent stderr. There
is no signal at all.

So the Rust wrapper must:

- **branch on `stderr` non-empty OR `stdout` empty — never on the exit code**; and
- **dispatch on sniffed magic bytes, never on the file extension**, so a mislabelled or
  hostile file never reaches `textutil` in the first place:

```
%PDF   (25 50 44 46)  -> PDFKit
PK\x03\x04 (50 4b 03 04) -> confirm word/document.xml or content.xml, then textutil
{\rtf  (7b 5c 72 74 66) -> textutil
'<' / <!DOCTYPE / <html -> textutil
otherwise -> must validate as UTF-8 to be treated as .txt; else reject
```

Note the inversion against PDFKit below: **textutil is judged by its streams, PDFKit by its
exit code.** Getting these backwards produces exactly the silent-garbage failure Atlas
School must not have.

---

## 2. PDF — the hard case

### 2a. Fixtures

`cupsfilter` is at **`/usr/sbin/cupsfilter`**, not `/usr/bin`, and still ships on 26.3:

```
/usr/sbin/cupsfilter -i text/plain -m application/pdf long.txt > multipage.pdf
$ file multipage.pdf
multipage.pdf: PDF document, version 1.3, 3 pages
```

A 55-page fixture was built the same way. Aside worth recording: `file` **under-reports
page count** on nested page trees — it called the large fixture "8 pages" where both PDFKit
and the PDF's own `/Count 55` say 55. Never use `file` for page counts.

### 2b. Every macOS shell-out was tested. All of them fail.

| candidate | result |
| --- | --- |
| `textutil -convert txt` on a PDF | **Catastrophic.** exit 0, 37,246 bytes, **empty stderr** — and the output literally begins `%PDF-1.3` and contains five `FlateDecode` markers. It passes the raw PDF through as mojibake. Zero extraction, total silence. |
| `mdls kMDItemTextContent` | `(null)`. `mdimport` exits 0 but never populates the attribute. |
| `strings` | 0 of 4 page markers found — content is Flate-compressed. |
| `/usr/bin/pdftotext`, `pstopdf`, `ps2pdf`, `gs`, `mutool` | **all NOT FOUND** |
| `python3` (Apple 3.9.6 and Homebrew) | `PyPDF2 / pypdf / fitz / pdfminer / Quartz / objc` all MISSING. Apple stripped PyObjC. |

Proof of the first row, re-run independently:

```
$ /usr/bin/textutil -convert txt -stdout -encoding UTF-8 multipage.pdf | head -c 64 | od -c
0000000    %   P   D   F   -   1   .   3  \n   %  306 222 303 202 ...
exit=0  stderr=[]  bytes=37246
```

**There is no `/usr/bin` tool on macOS 26.3 that emits PDF text.** The `zip.rs` pattern is
not available for PDF, and that is a fact about the OS, not a preference.

### 2c. Rust crates — NO-GO

```
$ grep -niE 'pdf' src-tauri/Cargo.lock
(no occurrence of 'pdf' anywhere in Cargo.lock)
```

Nothing PDF-capable is locked. `pdf-extract` and friends would be a genuinely new
dependency tree — a font/encoding/CMap stack, maintained by volunteers, to reimplement
something the operating system already does correctly. Same shape of argument as `zip.rs`
declining to hand-roll INFLATE, and the same failure mode: a wrong glyph mapping is a
silently wrong assignment, not a crash.

(Incidentally, `zip 4.6.1` and `6.0.0` **are** in the lockfile and `zip.rs` still shells
out. The shell-out precedent is a deliberate stance, not a workaround for a missing crate.)

### 2d. PDFKit — GO. This is the choice.

Two forms were built and both work, byte-for-byte identically (10,402 bytes on the 3-page
fixture, 250,492 on the 55-page one):

- an Objective-C shim (`clang -fobjc-arc -framework Foundation -framework PDFKit`), linkable
  via `build.rs` + the `cc` crate; and
- **pure Rust via `objc2-pdf-kit 0.3.2`.**

**Pick the Rust one.** It needs no `build.rs`, no `cc`, no `.m` file in the tree, and — per
ADR 010's lockfile experiment — it is a **single new package with zero version moves**:

```diff
+[[package]]
+name = "objc2-pdf-kit"
+version = "0.3.2"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "c14ed801ae810c6ba487cedd7616bb48f9a8e37940042f57e862538e2c7db117"
+dependencies = [
+ "bitflags 2.13.1",
+ "objc2",
+ "objc2-app-kit",
+ "objc2-core-foundation",
+ "objc2-core-graphics",
+ "objc2-foundation",
+]
```

Every one of those dependencies was already locked. `objc2` stays 0.6.4; the vergen pin is
untouched.

The whole extractor is roughly this:

```rust
use objc2::AllocAnyThread;                     // <- PDFDocument is NOT MainThreadOnly
use objc2_foundation::{NSString, NSURL};
use objc2_pdf_kit::PDFDocument;

let url = NSURL::fileURLWithPath(&NSString::from_str(path));
let doc = PDFDocument::initWithURL(PDFDocument::alloc(), &url)  // None => unreadable
    .ok_or(Unreadable)?;
if doc.isEncrypted() && doc.isLocked() { return Err(Locked) }
match doc.string() {                            // None or "" => no text layer
    Some(s) if !s.to_string().is_empty() => Ok(s.to_string()),
    _ => Err(NoTextLayer),
}
```

Measured behaviour of exactly that program:

```
== multipage.pdf ==  pages=3   status=0  bytes=10402
   head: PAGEMARKER_ALPHA Assignment Brief … bær blåbær rødgrød med fløde ÆØÅ æøå
== big.pdf ==        pages=55  status=0  bytes=250492
== scanned.pdf ==    pages=1   status=5  bytes=0
== blank.pdf ==      pages=1   status=5  bytes=0
== corrupt.bin ==              status=3  (unreadable)
```

Timings: **0.03 s** for 3 pages, **0.09–0.13 s** for 55 pages; the ObjC-shim build of the
same logic did a real 282-page / 1.8 MB PDF → 1.3 MB of text in **0.76–0.83 s**. Danish
characters survive.

**It runs off the main thread.** `objc2-pdf-kit` implements `AllocAnyThread` for
`PDFDocument` (it compiles without a `MainThreadMarker`), and the program above was
re-verified with the whole body moved into `std::thread::spawn(...).join()` — identical
output. That matters directly: per `reference_tauri_main_thread_trap`, a sync
`#[tauri::command]` runs on the main thread and blocking I/O there freezes the app and
blanks the Web Inspector. Extraction must be spawned onto a worker; PDFKit permits it.

**Read stderr, but do not branch on it.** CoreGraphics writes
`CoreGraphics PDF has logged an error. Set environment variable "CG_PDF_VERBOSE" to learn
more.` to stderr on malformed input. **Branch on the returned status, not on stderr** —
the exact inverse of the `textutil` rule.

---

## 3. Scanned / image-only PDFs — detectable, cleanly

A no-text-layer PDF was built (`qlmanage -t` → PNG → `sips -s format pdf`) and proven to
have none: **0 `/Font` objects** (versus 6 in the text PDF) and a single
`/XObject /Subtype /Image /Filter /DCTDecode`.

**PDFKit returns exactly 0 bytes.** Not whitespace, not partial garbage — `wc -c` is `0`
and `od -c` prints nothing. A blank-but-real PDF behaves the same way. So
"scanned document" is a **first-class, reliably detectable state**, and the product can say
so honestly instead of showing an empty assignment or hallucinating around one.

For contrast, on the same file `textutil` returns **910,516 bytes of mojibake** — it can
never tell a scanned PDF from a text one. That alone rules it out of the PDF path.

**OCR is out of scope here and is its own spike.** `Vision.framework` is present and
`VNRecognizeTextRequest` is the natural fallback, but nothing in this spike tested it.
Until it does, the honest product behaviour for a scanned PDF is: *"This PDF has no text
layer — it looks like a scan or a photo. I can't read it."*

---

## Decision

1. **Two mechanisms, dispatched on sniffed magic bytes.**
   `.txt/.html/.rtf/.doc/.docx/.odt` → `/usr/bin/textutil -convert txt -stdout -encoding
   UTF-8`, matching `zip.rs` exactly (absolute path, streamed stdout, nothing written to
   disk). PDF → `objc2-pdf-kit`.
2. **Add `objc2-pdf-kit = "0.3.2"`** to `src-tauri/Cargo.toml` with a comment in the house
   style noting it adds one package and no version moves (evidence in ADR 010). No
   `build.rs`, no `cc`, no Objective-C in the tree.
3. **Never trust `textutil`'s exit code.** Treat *stderr non-empty* or *stdout empty* as
   failure. Never trust its output for a file whose magic bytes were not verified first.
4. **Never trust PDFKit's stderr.** Branch on the status the wrapper returns.
5. **Give "no text layer" its own error variant**, distinct from "unreadable" and from
   "encrypted+locked", and surface it to the user as a scan. Do not let it fall through as
   an empty document.
6. **Run every extraction on a worker thread**, never inside a sync `#[tauri::command]`.
7. **Keep one seam.** As in `zip.rs`, whichever function returns the extracted `String` is
   the single swap point — for OCR later, or for a crate if this ever needs to be
   cross-platform.

## Where this is recorded

- `src-tauri/src/health/zip.rs` — the precedent this follows, and the one place where the
  shell-out reasoning is already written down.
- `docs/decisions/010-objc2-wifi-bluetooth-resolution.md` — the lockfile diff that includes
  `objc2-pdf-kit`.
- `src-tauri/Cargo.toml:85,108` — the "adds an edge, not a package" convention and the
  vergen pin that forbids `cargo update`.

## Not determined

- **Encrypted / password-protected PDFs.** The `isEncrypted && isLocked` branch is written
  but **never exercised** — no such fixture could be produced without extra tooling.
- **OCR / `Vision.framework`.** Present on the machine, entirely untested. Its own spike.
- **`.pages` files** and Google-Docs-exported `.docx` variants — untested.
- **Everything here ran unsigned from a CLI on macOS 26.3 (25D125), Apple silicon.** PDFKit
  is a system framework (`otool -L` confirms `/System/Library/Frameworks/PDFKit.framework`),
  so Xcode is a build-time need only — but this was not re-verified from inside a signed,
  notarized Atlas.app bundle.

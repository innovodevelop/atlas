/**
 * HTML → the readable copy of a page, as plain text blocks.
 *
 * The Beta Browser never renders a fetched page's HTML. The brain turns it into
 * a list of blocks — title, headings, paragraphs, list items, quotes, figure
 * captions — plus the page's links, and the webview draws those with its own
 * markup. So no script on the page can ever run, no style applies, and no
 * remote image, font or frame is ever requested: there is nothing to request
 * them with.
 *
 * This is a small tokenizer, not a browser parser, and it does not need to be:
 * it only has to find text and the few elements that give it shape. It skips
 * whole subtrees that are never reading copy (script, style, nav, footer,
 * aside, forms, svg, …) and prefers the page's <article>, then <main>, when
 * those hold enough text. Entities are decoded; whitespace collapses.
 *
 * Pure: a string in, data out. Tested in pageReader.test.ts.
 */

export type ReaderBlockKind = "heading" | "paragraph" | "item" | "quote" | "caption" | "code";

export interface ReaderBlock {
  kind: ReaderBlockKind;
  text: string;
  /** Headings only: 1–6. */
  level?: number;
}

export interface ReaderLink {
  text: string;
  href: string;
}

export interface ReaderPage {
  title: string;
  /** The site's own name, when it gives one (og:site_name). */
  siteName: string | null;
  /** The author, when the page names one (meta author / article:author). */
  byline: string | null;
  description: string | null;
  lang: string | null;
  blocks: ReaderBlock[];
  links: ReaderLink[];
  words: number;
  /** True when blocks were dropped to stay under MAX_TEXT. */
  clipped: boolean;
}

/** Text kept per page: well past any article, well under what a tab can store. */
export const MAX_TEXT = 200_000;
export const MAX_LINKS = 300;

/** Subtrees that are never the page's reading copy. */
const SKIP = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "embed",
  "video", "audio", "picture", "map", "nav", "footer", "aside", "form", "button", "select",
  "textarea", "dialog", "head", "menu",
]);

/** Elements whose content is raw text up to their own end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "iframe", "noembed", "noframes"]);

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen",
]);

/** Elements that start a new block of text when they open or close. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav", "ol", "p",
  "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "br", "caption", "center",
]);

/* ── Entities ─────────────────────────────────────────────────────────────── */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  deg: "°", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
  shy: "", zwj: "", zwnj: "", thinsp: " ", ensp: " ", emsp: " ", sect: "§", para: "¶",
  aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", auml: "ä", Auml: "Ä", ouml: "ö",
  Ouml: "Ö", uuml: "ü", Uuml: "Ü", eacute: "é", Eacute: "É", egrave: "è", agrave: "à", aacute: "á", iacute: "í",
  oacute: "ó", uacute: "ú", ntilde: "ñ", ccedil: "ç", szlig: "ß", frac12: "½", frac14: "¼", frac34: "¾",
  plusmn: "±", minus: "−", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", prime: "′", Prime: "″",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    const v = NAMED[body] ?? NAMED[body.toLowerCase()];
    return v ?? whole;
  });
}

function collapse(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim();
}

/* ── Tokenizer ────────────────────────────────────────────────────────────── */

type Token =
  | { t: "text"; text: string }
  | { t: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { t: "close"; name: string };

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Yields tokens; comments, doctypes and processing instructions are dropped. */
export function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const n = html.length;
  // Lower-cased once, for finding raw-text end tags without rescanning per tag.
  let lower: string | null = null;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { t: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { t: "text", text: html.slice(i, lt) };
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/.exec(html.slice(lt, lt + 200));
      if (!m) {
        // Not a tag after all: a literal "</".
        yield { t: "text", text: "</" };
        i = lt + 2;
        continue;
      }
      yield { t: "close", name: m[1].toLowerCase() };
      i = lt + m[0].length;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
    if (!nameMatch) {
      yield { t: "text", text: "<" };
      i = lt + 1;
      continue;
    }
    // Find the tag's end, honouring quoted attribute values.
    let j = lt + nameMatch[0].length;
    let quote: string | null = null;
    while (j < n) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; } else if (c === "\"" || c === "'") quote = c; else if (c === ">") break;
      j++;
    }
    const name = nameMatch[1].toLowerCase();
    const inner = html.slice(lt + nameMatch[0].length, j);
    const selfClosing = inner.trimEnd().endsWith("/");
    yield { t: "open", name, attrs: parseAttrs(inner), selfClosing };
    i = j + 1;
    if (RAW_TEXT.has(name) && !selfClosing) {
      // Everything up to the matching end tag is text (title) or nothing (script).
      lower ??= html.toLowerCase();
      const close = lower.indexOf(`</${name}`, i);
      const end = close === -1 ? n : close;
      if (name === "title") yield { t: "text", text: html.slice(i, end) };
      i = end;
    }
  }
}

/* ── Blocks ───────────────────────────────────────────────────────────────── */

interface Collected extends ReaderBlock {
  inArticle: boolean;
  inMain: boolean;
}

function resolveHref(href: string, base: URL | null): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Read a page. `pageUrl` resolves relative links (a <base href> on the page
 * wins, as in a browser).
 */
export function readPage(html: string, pageUrl: string | null = null): ReaderPage {
  let base: URL | null = null;
  try { base = pageUrl ? new URL(pageUrl) : null; } catch { base = null; }

  const stack: string[] = [];
  let skipDepth = 0;
  let title = "";
  let inTitle = false;
  let titleDone = false;
  const meta: Record<string, string> = {};
  let lang: string | null = null;

  const collected: Collected[] = [];
  let buf = "";
  const linkMap = new Map<string, string>();
  let link: { href: string | null; text: string } | null = null;

  const has = (name: string) => stack.includes(name);
  const kindNow = (): { kind: ReaderBlockKind; level?: number } => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const s = stack[k];
      if (/^h[1-6]$/.test(s)) return { kind: "heading", level: Number(s[1]) };
      if (s === "figcaption" || s === "caption") return { kind: "caption" };
      if (s === "pre") return { kind: "code" };
      if (s === "li" || s === "dd" || s === "dt") return has("blockquote") ? { kind: "quote" } : { kind: "item" };
      if (s === "blockquote" || s === "q") return { kind: "quote" };
    }
    return { kind: "paragraph" };
  };
  const flush = () => {
    const text = collapse(buf);
    buf = "";
    if (!text) return;
    const { kind, level } = kindNow();
    collected.push({ kind, text, ...(level ? { level } : {}), inArticle: has("article"), inMain: has("main") || stack.some((s) => s === "[role=main]") });
  };
  const pop = (name: string) => {
    const at = stack.lastIndexOf(name);
    if (at === -1) return false;
    for (let k = stack.length - 1; k >= at; k--) {
      const s = stack[k];
      if (SKIP.has(s) || s === "[skip]") skipDepth--;
    }
    stack.length = at;
    return true;
  };

  for (const tok of tokenize(html)) {
    if (tok.t === "text") {
      if (inTitle) { if (!titleDone) title += tok.text; continue; }
      if (skipDepth > 0) continue;
      const text = decodeEntities(tok.text);
      buf += text;
      if (link) link.text += text;
      continue;
    }
    if (tok.t === "open") {
      const { name, attrs } = tok;
      if (name === "html" && attrs.lang) lang = attrs.lang;
      if (name === "base" && attrs.href && base) {
        try { base = new URL(attrs.href, base); } catch { /* keep the page's own */ }
      }
      if (name === "meta") {
        const key = (attrs.property || attrs.name || "").toLowerCase();
        if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
        continue;
      }
      if (name === "title" && !tok.selfClosing && !has("svg")) { inTitle = !titleDone; continue; }
      if (VOID.has(name)) {
        if (skipDepth === 0 && (name === "br" || name === "hr")) {
          if (has("pre")) buf += "\n"; else flush();
        }
        continue;
      }
      if (tok.selfClosing) continue;
      // A body that opens while <head> is still open ends the head, as browsers do.
      if (name === "body") pop("head");
      // Implicit ends: a new <p> or <li> closes the open one, as browsers do.
      if (name === "p" && stack[stack.length - 1] === "p") { flush(); pop("p"); }
      if (name === "li") { const li = stack.lastIndexOf("li"); const list = Math.max(stack.lastIndexOf("ul"), stack.lastIndexOf("ol")); if (li > list) { flush(); pop("li"); } }
      if (BLOCK.has(name) && skipDepth === 0) flush();
      const hidden = "hidden" in attrs || attrs["aria-hidden"] === "true" || /display\s*:\s*none/i.test(attrs.style ?? "");
      const role = (attrs.role ?? "").toLowerCase();
      const skipByRole = role === "navigation" || role === "banner" || role === "contentinfo" || role === "complementary" || role === "search" || role === "dialog";
      if (SKIP.has(name)) skipDepth++;
      else if (hidden || skipByRole) { skipDepth++; stack.push(name, "[skip]"); continue; }
      stack.push(name);
      if (role === "main") stack.push("[role=main]");
      if (name === "a" && skipDepth === 0) link = { href: attrs.href ? resolveHref(attrs.href, base) : null, text: "" };
      continue;
    }
    // close
    const { name } = tok;
    if (name === "title") { if (inTitle) { inTitle = false; titleDone = true; } continue; }
    if (name === "a" && link) {
      const text = collapse(link.text);
      if (link.href && text && !linkMap.has(link.href) && linkMap.size < MAX_LINKS) linkMap.set(link.href, text.slice(0, 160));
      link = null;
    }
    if (!stack.includes(name)) continue;
    if (BLOCK.has(name) && skipDepth === 0) flush();
    // A [skip] marker sits right above the element it hides.
    const at = stack.lastIndexOf(name);
    if (stack[at + 1] === "[skip]") { pop(name); continue; }
    if (stack[at + 1] === "[role=main]") { stack.splice(at + 1, 1); }
    pop(name);
  }
  flush();

  // Prefer the article, then main, when either holds enough to read.
  const textOf = (bs: Collected[]) => bs.reduce((n, b) => n + b.text.length, 0);
  const inArticle = collected.filter((b) => b.inArticle);
  const inMain = collected.filter((b) => b.inMain);
  const chosen = textOf(inArticle) >= 280 ? inArticle : textOf(inMain) >= 280 ? inMain : collected;

  const cleanTitle = collapse(decodeEntities(title)) || collapse(meta["og:title"] ?? "") ||
    chosen.find((b) => b.kind === "heading")?.text || (base ? base.host : "Untitled page");

  let blocks: ReaderBlock[] = chosen.map(({ kind, text, level }) => (level ? { kind, text, level } : { kind, text }));
  // The page's own h1 usually repeats the title; the reader shows the title once.
  const first = blocks.find((b) => b.kind === "heading");
  if (first && sameText(first.text, cleanTitle)) blocks = blocks.filter((b) => b !== first);
  // Drop a block that only repeats the one before it (sticky headers, share bars).
  blocks = blocks.filter((b, k) => k === 0 || b.text !== blocks[k - 1].text);

  let total = 0;
  let clipped = false;
  const kept: ReaderBlock[] = [];
  for (const b of blocks) {
    if (total + b.text.length > MAX_TEXT) { clipped = true; break; }
    total += b.text.length;
    kept.push(b);
  }

  const words = kept.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0);
  const author = meta["author"] || meta["article:author"] || null;
  return {
    title: cleanTitle,
    siteName: meta["og:site_name"] ? collapse(meta["og:site_name"]) : null,
    byline: author && !/^https?:/i.test(author) ? collapse(author) : null,
    description: collapse(meta["description"] ?? meta["og:description"] ?? "") || null,
    lang,
    blocks: kept,
    links: [...linkMap].map(([href, text]) => ({ href, text })),
    words,
    clipped,
  };
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length > 12 && y.startsWith(x));
}

/** Plain text (text/plain): blank lines separate paragraphs. */
export function readPlainText(text: string, pageUrl: string): ReaderPage {
  let host = pageUrl;
  try { host = new URL(pageUrl).host; } catch { /* keep the raw address */ }
  const blocks: ReaderBlock[] = [];
  let total = 0;
  let clipped = false;
  for (const para of text.split(/\n\s*\n/)) {
    const t = collapse(para);
    if (!t) continue;
    if (total + t.length > MAX_TEXT) { clipped = true; break; }
    total += t.length;
    blocks.push({ kind: "paragraph", text: t });
  }
  const name = pageUrl.split("/").filter(Boolean).pop() ?? host;
  return {
    title: name, siteName: null, byline: null, description: null, lang: null, blocks, links: [],
    words: blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0), clipped,
  };
}

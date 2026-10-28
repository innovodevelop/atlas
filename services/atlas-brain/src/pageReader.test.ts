// HTML → reader blocks (pageReader.ts). The reader is the only thing between a
// fetched page and the screen, so the tests that matter most are the ones that
// prove what never comes through: scripts, styles, hidden text, chrome.
import { describe, expect, test } from "bun:test";
import { decodeEntities, readPage, readPlainText, sameTitle, tokenize, MAX_DEPTH, MAX_LINKS } from "./pageReader.ts";

const ARTICLE = `<!doctype html>
<html lang="en-GB">
<head>
  <title>Heat pumps vs gas boilers &mdash; a buyer&#8217;s guide | Heatwise</title>
  <meta property="og:site_name" content="Heatwise">
  <meta name="author" content="Sonia Reyes">
  <meta name="description" content="What a heat pump costs &amp; saves.">
  <script>window.evil = "<p>never shown</p>";</script>
  <style>p { color: red }</style>
</head>
<body>
  <header class="site-header"><a href="/">Heatwise home</a></header>
  <nav><ul><li><a href="/a">Menu item</a></li></ul></nav>
  <main>
    <article>
      <h1>Heat pumps vs gas boilers &mdash; a buyer&#8217;s guide</h1>
      <p>A well-sized air-source heat pump now costs between £8,000 and £14,000 installed, before the grant. That puts the net cost close to a new gas boiler.</p>
      <p>Running costs depend on two numbers: <a href="/tariffs#top">your tariff</a> and the seasonal efficiency of the pump.<sup class="reference"><a href="#cite-1">[1]</a></sup></p>
      <h2>Noise</h2>
      <ul><li>Around 40 dB at a metre<li>Quieter than a fridge</ul>
      <blockquote><p>The pump is the easy part. The house is the project.</p></blockquote>
      <figure><img src="https://cdn.example/pump.jpg" alt="A pump"><figcaption>An outdoor unit in winter.</figcaption></figure>
      <pre><code>cop = heat / power</code></pre>
      <div hidden>Hidden text</div>
      <div style="display: none">Display none text</div>
      <span aria-hidden="true">Aria hidden text</span>
      <div class="share-bar">Share this on everything</div>
      <form><label>Email <input name="e"></label><button>Subscribe</button></form>
      <script src="/a.js" />var alsoNever = 1;</script>
      <p>Links: <a href="https://other.example/x">another site</a>, <a href="javascript:alert(1)">a script</a>, <a href="mailto:a@b.co">mail</a>.</p>
    </article>
    <aside>Related: a sidebar</aside>
  </main>
  <footer><a href="/privacy">Privacy</a></footer>
</body>
</html>`;

describe("readPage", () => {
  const page = readPage(ARTICLE, "https://heatwise.example/guides/pumps");
  const text = page.blocks.map((b) => b.text).join("\n");

  test("takes the title from the page's own heading, without the site suffix", () => {
    expect(page.title).toBe("Heat pumps vs gas boilers — a buyer’s guide");
    // …and shows it once, not again as the first block.
    expect(page.blocks[0].kind).toBe("paragraph");
  });

  test("reads the metadata", () => {
    expect(page.siteName).toBe("Heatwise");
    expect(page.byline).toBe("Sonia Reyes");
    expect(page.description).toBe("What a heat pump costs & saves.");
    expect(page.lang).toBe("en-GB");
  });

  test("keeps the article's shape", () => {
    expect(page.blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "heading", "item", "item", "quote", "caption", "code", "paragraph"]);
    expect(page.blocks[2]).toEqual({ kind: "heading", text: "Noise", level: 2 });
    expect(page.blocks[3].text).toBe("Around 40 dB at a metre");
    expect(page.blocks[4].text).toBe("Quieter than a fridge");
    expect(page.blocks[5].text).toBe("The pump is the easy part. The house is the project.");
    expect(page.blocks[6].text).toBe("An outdoor unit in winter.");
    expect(page.blocks[7].text).toBe("cop = heat / power");
  });

  test("no script, style, hidden text, form or chrome comes through", () => {
    for (const never of ["never shown", "evil", "color: red", "Hidden text", "Display none text", "Aria hidden text", "Share this", "Subscribe", "alsoNever", "Menu item", "Heatwise home", "sidebar", "Privacy", "[1]"]) {
      expect([never, text.includes(never)]).toEqual([never, false]);
    }
  });

  test("keeps inline text whole and decodes entities", () => {
    expect(page.blocks[1].text).toBe("Running costs depend on two numbers: your tariff and the seasonal efficiency of the pump.");
  });

  test("links: absolute, http(s) only, no fragments, only from the copy the reader chose", () => {
    expect(page.links).toEqual([
      { href: "https://heatwise.example/tariffs", text: "your tariff" },
      { href: "https://other.example/x", text: "another site" },
    ]);
  });

  test("no image is ever part of the page", () => {
    expect(JSON.stringify(page)).not.toContain("pump.jpg");
  });

  test("counts words", () => {
    expect(page.words).toBeGreaterThan(50);
    expect(page.clipped).toBe(false);
  });
});

describe("choosing the copy", () => {
  test("falls back to main, then the whole body, when there is no article", () => {
    const body = `<body><div>Intro line</div><main><p>${"Main copy. ".repeat(40)}</p></main><div>Outro</div></body>`;
    const p = readPage(body, "https://a.example/");
    expect(p.blocks.map((b) => b.text).join(" ")).not.toContain("Intro line");
    const short = readPage("<body><p>Only this.</p><div>And this.</div></body>", "https://a.example/");
    expect(short.blocks.map((b) => b.text)).toEqual(["Only this.", "And this."]);
  });

  test("a class that says chrome hides its subtree, unless it also says content", () => {
    const html = `<article><p>${"Copy. ".repeat(60)}</p><div class="cookie-banner">Accept cookies</div><div class="main-content sidebar-layout"><p>Kept text.</p></div><ul class="menu"><li>Home</li></ul></article>`;
    const t = readPage(html, null).blocks.map((b) => b.text).join("\n");
    expect(t).not.toContain("Accept cookies");
    expect(t).not.toContain("Home");
    expect(t).toContain("Kept text.");
  });

  test("a <base href> resolves relative links, as in a browser", () => {
    const p = readPage(`<head><base href="https://cdn.example/docs/"></head><body><p><a href="intro">Intro</a> and more words.</p></body>`, "https://a.example/x");
    expect(p.links).toEqual([{ href: "https://cdn.example/docs/intro", text: "Intro" }]);
  });

  test("caps the links it keeps", () => {
    const many = Array.from({ length: MAX_LINKS + 50 }, (_, i) => `<a href="/p${i}">Link ${i}</a>`).join(" ");
    expect(readPage(`<body><p>${many}</p></body>`, "https://a.example/").links.length).toBe(MAX_LINKS);
  });

  test("a title with no heading, and a page with no title", () => {
    expect(readPage("<title>Just a title</title><p>Text.</p>", null).title).toBe("Just a title");
    expect(readPage("<p>Text.</p>", "https://a.example/x").title).toBe("a.example");
  });

  test("survives broken markup without throwing", () => {
    for (const bad of ["<p>unclosed <b>bold", "<<<>>>", "</div></div><p>x", "<a href='x>broken", "<!-- never closed", "<script>forever", "a < b and c > d"]) {
      expect(() => readPage(bad, "https://a.example/")).not.toThrow();
    }
    expect(readPage("a < b and c > d", null).blocks[0].text).toBe("a < b and c > d");
  });
});

describe("sameTitle", () => {
  test("the heading before a site suffix is the title", () => {
    expect(sameTitle("Heat pump", "Heat pump - Wikipedia")).toBe(true);
    expect(sameTitle("Bun", "Bun | Docs")).toBe(true);
    expect(sameTitle("Same", "same")).toBe(true);
  });
  test("a heading that only starts the title is not", () => {
    expect(sameTitle("News", "News about cats")).toBe(false);
    expect(sameTitle("", "Anything")).toBe(false);
  });
});

describe("pieces", () => {
  test("decodeEntities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#8217; &#x2014; &nbsp;x &unknown; &#0;")).toBe("a & b <c> ’ —  x &unknown; �");
  });
  test("tokenize drops comments and doctypes", () => {
    const toks = [...tokenize("<!doctype html><!-- c --><p class='a'>x</p>")];
    expect(toks).toEqual([
      { t: "open", name: "p", attrs: { class: "a" }, selfClosing: false },
      { t: "text", text: "x" },
      { t: "close", name: "p" },
    ]);
  });
  test("readPlainText splits on blank lines", () => {
    const p = readPlainText("First para\nstill first.\n\nSecond.", "https://a.example/notes.txt");
    expect(p.title).toBe("notes.txt");
    expect(p.blocks.map((b) => b.text)).toEqual(["First para still first.", "Second."]);
  });
});

// readPage runs inside the /browser/fetch request, so a page that leaves
// thousands of tags open must not hold the brain's event loop.
describe("deep and broken nesting", () => {
  test("300k nested, never-closed <div>s read in well under a second", () => {
    const html = "<div>a".repeat(300_000);
    const t0 = performance.now();
    const p = readPage(html, "https://deep.example/");
    expect(performance.now() - t0).toBeLessThan(1000);
    // Every "a" is its own block, and repeats collapse to one.
    expect(p.blocks).toEqual([{ kind: "paragraph", text: "a" }]);
  });

  test("other open-ended shapes stay linear too: cells, lists, quotes, links", () => {
    for (const html of [
      "<table><tr>" + "<td>x".repeat(200_000),
      "<ul>" + "<li>x<ul>".repeat(150_000),
      "<blockquote>q".repeat(200_000),
      '<div role="main">m'.repeat(100_000),
      '<a href="/x">l'.repeat(150_000),
    ]) {
      const t0 = performance.now();
      readPage(html, "https://deep.example/");
      expect([html.slice(0, 20), performance.now() - t0 < 1000]).toEqual([html.slice(0, 20), true]);
    }
  });

  test(`past ${MAX_DEPTH} levels elements read as text, and their end tags close only themselves`, () => {
    const filler = "Body text long enough to make the article the reading copy on its own, ".repeat(5);
    const html = `<body><article><h1>Deep</h1>${"<div>".repeat(MAX_DEPTH + 50)}<h3>Way down</h3><p>${filler}</p>${"</div>".repeat(MAX_DEPTH + 50)}`
      + `<li>After the deep part, still inside the article.</li></article><div>Outside the article.</div></body>`;
    const p = readPage(html, "https://deep.example/");
    const texts = p.blocks.map((b) => b.text);
    // Too deep to nest, so the heading reads as a paragraph...
    expect(p.blocks.find((b) => b.text === "Way down")?.kind).toBe("paragraph");
    expect(texts).toContain(filler.trim());
    // ...but the stack comes back intact: the item is still in the article,
    // and what follows the article is still outside it.
    expect(p.blocks.find((b) => b.text.startsWith("After the deep part"))?.kind).toBe("item");
    expect(texts).not.toContain("Outside the article.");
  });

  test("a skipped subtree still closes after deep nesting inside it", () => {
    const html = `<article><nav>${"<div>".repeat(MAX_DEPTH + 10)}menu${"</div>".repeat(MAX_DEPTH + 10)}</nav><p>${"Readable. ".repeat(40)}</p></article>`;
    const p = readPage(html);
    expect(p.blocks.map((b) => b.text)).toEqual(["Readable. ".repeat(40).trim()]);
  });
});

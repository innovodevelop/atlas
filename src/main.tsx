import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
// Single consolidated stylesheet (base layer + Workshop design, cascade order
// preserved from the former atlas.css + workshop.css).
import "./styles/workshop.css";

createRoot(document.getElementById("root")!).render(<App />);

// Dev-only click-blocker watchdog.
//
// Twice now a full-viewport element has been left invisible-but-interactive —
// an entrance animation with `fill-mode: both` that WKWebView never ran, so the
// element sat at opacity:0 while still swallowing every click. The app looks
// completely normal and still scrolls, which makes it near-impossible to spot:
// the only symptom is "nothing is clickable".
//
// This catches it the moment it happens, by name, during development. Stripped
// entirely from production builds — `import.meta.env.DEV` is statically false
// there, so the whole block is dead code that Vite removes.
if (import.meta.env.DEV) {
  window.setInterval(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    for (let el = hit as Element | null; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const coversViewport = r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95;
      const invisible = Number(cs.opacity) < 0.01 || cs.visibility === 'hidden';
      if (coversViewport && invisible && cs.pointerEvents !== 'none') {
        console.error(
          `[atlas] CLICK BLOCKER: <${el.tagName.toLowerCase()} class="${el.className}"> covers the ` +
          `viewport at opacity ${cs.opacity} but still accepts pointer events. ` +
          `Give it an opacity:1 base and use "forwards", not "both".`,
        );
        return;
      }
    }
  }, 3000);
}

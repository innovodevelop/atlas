import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * The edition this build is for — see `src/surfaces.ts` for the mechanism.
 *
 * Read here rather than left to Vite's own `VITE_*` env exposure so that the
 * value is (a) validated and (b) injected as a `define`, which makes the
 * literal substitution unconditional instead of a side effect of env loading.
 * The whole consumer/admin split rests on Rollup being able to constant-fold
 * `EDITION === 'admin'`; if that substitution silently stops happening, the
 * admin pages come back and nothing fails loudly. A `define` cannot silently
 * stop happening.
 *
 * A TYPO MUST NOT BUILD. `VITE_ATLAS_EDITION=Consumer` falling back to 'admin'
 * would produce an admin bundle that then ships to `dist/` as Atlas.app — the
 * exact failure this split exists to prevent, arrived at by a capital letter.
 */
const RAW_EDITION = process.env.VITE_ATLAS_EDITION;
if (RAW_EDITION !== undefined && RAW_EDITION !== "consumer" && RAW_EDITION !== "admin") {
  throw new Error(
    `VITE_ATLAS_EDITION must be 'consumer' or 'admin' (got '${RAW_EDITION}'). ` +
      `Use 'bun run build' for Atlas (consumer) or 'bun run build:admin' for Lighthouse.`,
  );
}
/** Unset ⇒ admin, matching `src/surfaces.ts`: an unconfigured build ships everything. */
const EDITION: "consumer" | "admin" = RAW_EDITION === "consumer" ? "consumer" : "admin";

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  esbuild: {
    // Strip debug output from production builds; keep it in dev.
    drop: command === "build" ? (["console", "debugger"] as ("console" | "debugger")[]) : [],
  },
  define: {
    "import.meta.env.VITE_ATLAS_EDITION": JSON.stringify(EDITION),
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Two editions, two output directories, so building one can never
    // overwrite the other and each Tauri config can point at exactly the
    // bundle it means. `dist/` stays the consumer output because that is what
    // `src-tauri/tauri.conf.json` (Atlas.app) has always read.
    outDir: EDITION === "consumer" ? "dist" : "dist-admin",
    // WKWebView (macOS 13+) and modern browsers only — skips legacy
    // transforms and shrinks output.
    target: "safari16",
    rollupOptions: {
      output: {
        // Keep heavyweight libraries out of the entry chunk.
        //
        // FUNCTION FORM, NOT THE OBJECT FORM. `manualChunks: { mermaid: ['mermaid'] }`
        // names a module to INCLUDE, so Rollup would pull mermaid into the
        // graph whether or not anything imported it. The function form only
        // ever sees modules Rollup already resolved.
        //
        // mermaid is grouped in the admin build only. Its sole importer is
        // /atlas-architecture, which a consumer build does not route — but
        // Rollup still walks every `import()` it can see while building the
        // module graph, so mermaid's modules are visited and then shaken to
        // nothing. Naming a chunk after them in the consumer build produced a
        // 1.09 kB `mermaid-*.js` holding only Vite's preload helper: no
        // mermaid code, but a filename that says otherwise in a bundle that
        // must be auditable at a glance. Grouping only where the code is real
        // keeps the consumer output honest.
        //
        // The `three` chunk is gone: three.js, @react-three/fiber, drei and
        // postprocessing were removed with the WebGL sphere. That chunk was
        // 1,007,799 bytes, and it was fetched by the dashboard — the app's
        // default route — through AtlasSphereLazy.
        manualChunks(id: string) {
          if (EDITION === "admin" && id.includes("node_modules/mermaid")) return "mermaid";
          if (id.includes("node_modules/recharts")) return "recharts";
          return undefined;
        },
      },
    },
  },
}));

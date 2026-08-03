import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  esbuild: {
    // Strip debug output from production builds; keep it in dev.
    drop: command === "build" ? (["console", "debugger"] as ("console" | "debugger")[]) : [],
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
    // WKWebView (macOS 13+) and modern browsers only — skips legacy
    // transforms and shrinks output.
    target: "safari16",
    rollupOptions: {
      output: {
        // Keep heavyweight libraries out of the entry chunk. mermaid is only
        // used by the lazy /atlas-architecture route.
        //
        // The `three` chunk is gone: three.js, @react-three/fiber, drei and
        // postprocessing were removed with the WebGL sphere. That chunk was
        // 1,007,799 bytes, and it was fetched by the dashboard — the app's
        // default route — through AtlasSphereLazy.
        manualChunks: {
          mermaid: ["mermaid"],
          recharts: ["recharts"],
        },
      },
    },
  },
}));

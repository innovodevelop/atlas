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
        // used by the lazy /atlas-architecture route; three powers the sphere.
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei", "@react-three/postprocessing"],
          mermaid: ["mermaid"],
          recharts: ["recharts"],
        },
      },
    },
  },
}));

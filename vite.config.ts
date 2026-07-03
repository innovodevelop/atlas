import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
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
});

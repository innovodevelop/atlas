import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // supabase/functions run on Deno (not the browser) and are typechecked
  // separately with `deno check`; linting them with the React/browser config
  // is incorrect. src-tauri is Rust. scripts are one-off Node utilities.
  // `dist-admin` is the Lighthouse (admin edition) frontend build — the same
  // kind of output as `dist`, produced by `bun run build:admin`. Linting a
  // minified bundle reports rules that are not configured and fails the gate.
  // `scripts` is NOT ignored any more: it now holds shipped tooling with its
// own test suite (scripts/new-surface.ts + newSurface.test.ts), and an
// ignored directory is a directory the lint gate lies about.
{ ignores: ["dist", "dist-admin", "supabase/functions", "src-tauri"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Genuine dynamic boundaries where `any` is unavoidable: the generic
    // Supabase CRUD wrappers hit the client's deep-type-instantiation limit
    // on dynamic table names, the scribe SDK lacks types, and the voice
    // gateway wraps dynamically imported ONNX runtimes + an injected
    // Supabase client (runtime-neutral module contract).
    files: [
      "src/hooks/useCrudOperations.ts",
      "src/hooks/useRealtimeScribeStable.ts",
      "services/voice-gateway/**/*.ts",
    ],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // R11 type-safety ratchet (ADR 015): re-enable the rule the top-level
    // config turns off, scoped to the same src/lib/ boundary tsconfig.strict.json
    // enforces. Every future wave widens this `files` glob outward alongside
    // the tsconfig boundary; neither one narrows back.
    //
    // argsIgnorePattern respects this file's existing `_x`/`_ms`-style
    // convention for params a fake/mock must accept to match an interface
    // (FakePath2D.moveTo, fakeClock's scheduler) but never reads — an
    // explicit "deliberately unused" marker, not a rule weakening; a
    // non-underscored unused arg or var still fails.
    files: ["src/lib/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);

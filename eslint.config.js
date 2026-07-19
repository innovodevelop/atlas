import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // supabase/functions run on Deno (not the browser) and are typechecked
  // separately with `deno check`; linting them with the React/browser config
  // is incorrect. src-tauri is Rust. scripts are one-off Node utilities.
  { ignores: ["dist", "supabase/functions", "src-tauri", "scripts"] },
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
      "src/hooks/useSupabaseQuery.ts",
      "src/hooks/useRealtimeScribeStable.ts",
      "services/voice-gateway/**/*.ts",
    ],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);

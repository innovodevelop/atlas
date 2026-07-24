/**
 * Bun file-loader imports (`with { type: "file" }`) resolve to a path string at
 * runtime. Declared here rather than per-import so the types hold whether or not
 * models/ has been fetched yet — `resolveJsonModule` is off for the same reason.
 */
declare module "*.onnx" {
  const path: string;
  export default path;
}
declare module "*.wasm" {
  const path: string;
  export default path;
}
declare module "*.mjs" {
  const path: string;
  export default path;
}
declare module "*.json" {
  const path: string;
  export default path;
}

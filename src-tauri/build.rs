fn main() {
  // Sidecar integrity manifest (see src/integrity.rs): bake the expected
  // SHA-256 digests of the sidecar binaries into the app binary at COMPILE
  // time, so an attacker who swaps a sidecar inside the bundle cannot also
  // edit the digest it is verified against. scripts/gen-sidecar-manifest.ts
  // writes binaries/manifest.json after the sidecars compile; when it is
  // absent (fresh dev checkout, `tauri dev` without built sidecars) we embed
  // an empty manifest — integrity.rs then warns-and-allows in debug builds
  // but refuses to spawn in release builds.
  println!("cargo:rerun-if-changed=binaries/manifest.json");
  let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR not set"));
  let manifest =
    std::fs::read_to_string("binaries/manifest.json").unwrap_or_else(|_| String::from("{}"));
  std::fs::write(out.join("sidecar-manifest.json"), manifest)
    .expect("failed to write sidecar-manifest.json to OUT_DIR");

  // The wake-word models (public/models/*.onnx) ship in the webview's assets,
  // which Tauri compiles into this executable. System Status's "Models on
  // device" counts them beside the sidecars' models (src/system_status.rs),
  // and this is the last moment they are files to measure.
  println!("cargo:rerun-if-changed=../public/models");
  let wake_word_bytes: u64 = std::fs::read_dir("../public/models")
    .map(|dir| {
      dir
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "onnx"))
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
    })
    .unwrap_or(0);
  println!("cargo:rustc-env=ATLAS_WAKE_WORD_MODEL_BYTES={wake_word_bytes}");

  tauri_build::build()
}

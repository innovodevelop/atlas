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

  tauri_build::build()
}

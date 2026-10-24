import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WAKE_MODELS, getActiveWakePhrases } from "./wakeWord";

const MODELS = join(import.meta.dir, "../../public/models");

describe("wake-word models", () => {
  test("the app listens for Hey Atlas", () => {
    expect(getActiveWakePhrases()).toEqual(["Hey Atlas"]);
  });

  test("every listed phrase model ships", () => {
    for (const m of WAKE_MODELS) expect(existsSync(join(MODELS, m.file.replace("/models/", "")))).toBe(true);
  });

  // Every model in public/models ships inside the app, so each one's licence
  // matters. The stock openWakeWord models are CC BY-NC-SA and once shipped
  // unnoticed; a new .onnx has to be added here (and to public/models/README.md
  // with its licence) on purpose.
  test("public/models holds only the backbone and the listed phrase models", () => {
    const onnx = readdirSync(MODELS).filter((f) => f.endsWith(".onnx")).sort();
    const known = ["speech_embedding.onnx", ...WAKE_MODELS.map((m) => m.file.replace("/models/", ""))].sort();
    expect(onnx).toEqual(known);
  });
});

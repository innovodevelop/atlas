import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModelFiles, fileUrl, MODEL_FILES, MODEL_REVISION, modelDir, type ModelFile } from "./modelStore.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function spec(local: string, content: string): ModelFile {
  return { remote: `onnx/${local}`, local, size: Buffer.byteLength(content), sha256: sha(content) };
}

function server(contents: Record<string, string>) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const name = url.split("/").pop()!;
    return name in contents ? new Response(contents[name]) : new Response("nope", { status: 404 });
  };
  return { fetcher, calls };
}

const quiet = () => {};

describe("modelStore", () => {
  test("downloads missing files, verifies them, and reuses them next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e5-"));
    const files = [spec("a.json", "tokenizer"), spec("b.onnx", "weights!")];
    const s = server({ "a.json": "tokenizer", "b.onnx": "weights!" });

    const paths = await ensureModelFiles({ dir, fetcher: s.fetcher, files, log: quiet });
    expect(Object.keys(paths)).toEqual(["a.json", "b.onnx"]);
    expect(await Bun.file(paths["b.onnx"]).text()).toBe("weights!");
    expect(s.calls).toHaveLength(2);

    await ensureModelFiles({ dir, fetcher: s.fetcher, files, log: quiet });
    expect(s.calls).toHaveLength(2); // nothing fetched the second time
  });

  test("a corrupted file on disk is replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e5-"));
    const files = [spec("b.onnx", "weights!")];
    writeFileSync(join(dir, "b.onnx"), "WEIGHTS!"); // right size, wrong bytes
    const s = server({ "b.onnx": "weights!" });
    const paths = await ensureModelFiles({ dir, fetcher: s.fetcher, files, log: quiet });
    expect(await Bun.file(paths["b.onnx"]).text()).toBe("weights!");
    expect(s.calls).toHaveLength(1);
  });

  test("a download that fails verification is never put in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e5-"));
    const files = [spec("b.onnx", "weights!")];
    const s = server({ "b.onnx": "tampered" });
    await expect(ensureModelFiles({ dir, fetcher: s.fetcher, files, log: quiet })).rejects.toThrow("failed verification");
    expect(existsSync(join(dir, "b.onnx"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // the temporary file is cleaned up too
  });

  test("an HTTP error is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e5-"));
    const s = server({});
    await expect(
      ensureModelFiles({ dir, fetcher: s.fetcher, files: [spec("b.onnx", "x")], log: quiet }),
    ).rejects.toThrow("HTTP 404");
  });

  test("files are pinned to one revision and live beside the database", () => {
    for (const f of MODEL_FILES) {
      expect(fileUrl(f)).toContain(`/resolve/${MODEL_REVISION}/`);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(modelDir({ ATLAS_DB_PATH: "/x/y/atlas.db" })).toBe("/x/y/models/multilingual-e5-base");
    expect(modelDir({ ATLAS_MODELS_DIR: "/m" })).toBe("/m/multilingual-e5-base");
  });
});

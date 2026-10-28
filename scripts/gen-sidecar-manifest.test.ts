/**
 * The sidecar manifest: digests and sizes for the integrity check, and the
 * model bytes System Status reports as "Models on device". Runs against a
 * throwaway tree in the temp folder; the repo's own binaries/ is never read
 * or written here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_DIRS, buildManifest, dirBytes } from './gen-sidecar-manifest';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-manifest-'));
  roots.push(root);
  mkdirSync(join(root, 'src-tauri', 'binaries'), { recursive: true });
  return root;
}

function file(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
}

describe('sidecar manifest', () => {
  test('each sidecar carries its digest, its size, and the bytes of the models compiled into it', async () => {
    const root = tree();
    // A sidecar is runtime + code + models: its size is not its models' size.
    file(join(root, 'src-tauri/binaries/atlas-brain-aarch64-apple-darwin'), 5000);
    file(join(root, MODEL_DIRS['atlas-brain'], 'multilingual-e5-base/model_quantized.onnx'), 1200);
    file(join(root, MODEL_DIRS['atlas-brain'], 'multilingual-e5-base/tokenizer.json'), 300);
    file(join(root, 'src-tauri/binaries/atlas-voice-gateway-aarch64-apple-darwin'), 2000);
    file(join(root, MODEL_DIRS['atlas-voice-gateway'], 'silero_vad.onnx'), 40);
    writeFileSync(join(root, 'src-tauri/binaries/manifest.json'), '{}');

    const m = await buildManifest(root);
    expect(Object.keys(m)).toEqual(['atlas-brain', 'atlas-voice-gateway']);
    expect(m['atlas-brain']).toMatchObject({ size: 5000, model_bytes: 1500 });
    expect(m['atlas-brain'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m['atlas-voice-gateway']).toMatchObject({ size: 2000, model_bytes: 40 });
  });

  test('a sidecar whose model folder is missing gets no count, not a zero', async () => {
    const root = tree();
    file(join(root, 'src-tauri/binaries/atlas-brain-aarch64-apple-darwin'), 10);
    const m = await buildManifest(root);
    expect(m['atlas-brain'].size).toBe(10);
    expect('model_bytes' in m['atlas-brain']).toBe(false);
  });

  test('a linked file or folder is not counted as a model', () => {
    const root = tree();
    const dir = join(root, 'models');
    file(join(dir, 'a.onnx'), 100);
    file(join(root, 'elsewhere/big.bin'), 9000);
    symlinkSync(join(root, 'elsewhere'), join(dir, 'linked'));
    symlinkSync(join(root, 'elsewhere/big.bin'), join(dir, 'big.bin'));
    expect(dirBytes(dir)).toBe(100);
  });
});

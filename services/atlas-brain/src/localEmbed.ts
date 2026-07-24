/**
 * On-device text embeddings — replaces the Gemini embeddings call in
 * _shared/aiGateway.ts for everything the brain does.
 *
 * Model: intfloat/multilingual-e5-base (MIT), int8-quantized ONNX export
 * (Xenova/multilingual-e5-base), 12 layers, hidden size 768 — which is exactly
 * the width memory_vectors.embedding / EMBEDDING_DIMENSIONS demand, so nothing
 * downstream changes. It is genuinely multilingual, so Danish memories embed as
 * well as English ones (the Gemini model's main practical advantage is gone).
 *
 * Runtime: onnxruntime-**web** (WASM) + @huggingface/tokenizers. Not
 * onnxruntime-node: its .dylib does not survive `bun build --compile`, and the
 * whole point is a sidecar binary that works with no network and no
 * node_modules. Weights, tokenizer and the ORT wasm all ship inside the binary
 * (see embeddedAssets.ts).
 *
 * Cost of that choice: the WASM session dequantizes the weights on load, so the
 * process sits at ~1.4 GiB RSS once loaded and takes ~1.5 s to warm. Both are
 * paid lazily — nothing loads until the first embed — and never on the chat
 * response path (see autoEmbed.ts).
 *
 * e5 was trained with asymmetric "query: " / "passage: " prefixes; using them
 * widens the hit/miss margin, so embedText() takes an optional role. Vectors are
 * mean-pooled over the attention mask and L2-normalized, which is what the
 * cosine in localMemory.recall() (and the Rust port) assumes.
 */

import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";
import {
  EMBED_ONNX,
  EMBED_TOKENIZER,
  EMBED_TOKENIZER_CONFIG,
  prepareOrtWasmDir,
} from "./embeddedAssets.ts";

/** Must match aiGateway.EMBEDDING_DIMENSIONS and db_schema's vector(768). */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Stamped into memory_vectors.source_ref_json so vectors from a *different*
 * embedding model can be spotted and rebuilt — cosine across two models is
 * meaningless, and this DB may still hold Gemini-era vectors.
 */
export const EMBEDDING_MODEL_ID = "multilingual-e5-base";

const MAX_TOKENS = 512; // model_max_length
const PAD_ID = 1n; // XLM-R <pad>

// 4 threads measured ~2x faster than 1 with no extra steady-state memory.
const THREADS = Number(process.env.ATLAS_EMBED_THREADS ?? 4);

interface Loaded {
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
}

let loading: Promise<Loaded> | null = null;

/** Load tokenizer + ONNX session once per process. */
function load(): Promise<Loaded> {
  loading ??= (async () => {
    const started = performance.now();
    // wasmPaths must be set before the first session is created — ORT resolves
    // its loader/wasm pair by canonical filename out of this directory.
    const dir = await prepareOrtWasmDir();
    ort.env.wasm.wasmPaths = dir.endsWith("/") ? dir : `${dir}/`;
    ort.env.wasm.numThreads = THREADS;
    ort.env.wasm.proxy = false;

    const tokenizer = new Tokenizer(
      await Bun.file(EMBED_TOKENIZER).json(),
      await Bun.file(EMBED_TOKENIZER_CONFIG).json(),
    );
    const session = await ort.InferenceSession.create(
      new Uint8Array(await Bun.file(EMBED_ONNX).arrayBuffer()),
    );
    console.log(`[brain] embedding model ready in ${(performance.now() - started).toFixed(0)} ms (${EMBEDDING_MODEL_ID})`);
    return { tokenizer, session };
  })();
  return loading;
}

/** Warm the model ahead of first use (optional — embedText loads on demand). */
export function preloadEmbedder(): Promise<unknown> {
  return load();
}

// One inference at a time: the WASM backend runs on this process's threads, so
// overlapping runs only add memory pressure and event-loop jitter.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export type EmbedRole = "query" | "passage";

/**
 * Embed one text into exactly EMBEDDING_DIMENSIONS L2-normalized floats.
 * `role` applies the e5 prefix — "passage" for stored memories (the default,
 * matching how backfill writes), "query" for search input.
 */
export async function embedText(text: string, role: EmbedRole = "passage"): Promise<number[]> {
  const { tokenizer, session } = await load();
  const input = `${role}: ${text.slice(0, 8000)}`;

  return serialize(async () => {
    const enc = tokenizer.encode(input);
    const len = Math.max(1, Math.min(MAX_TOKENS, enc.ids.length));
    const ids = new BigInt64Array(len);
    const mask = new BigInt64Array(len);
    for (let i = 0; i < len; i++) {
      ids[i] = i < enc.ids.length ? BigInt(enc.ids[i]) : PAD_ID;
      mask[i] = i < enc.ids.length ? 1n : 0n;
    }

    const out = await session.run({
      input_ids: new ort.Tensor("int64", ids, [1, len]),
      attention_mask: new ort.Tensor("int64", mask, [1, len]),
    });
    const hidden = out.last_hidden_state ?? out[session.outputNames[0]];
    const [, seq, hiddenSize] = hidden.dims as number[];
    if (hiddenSize !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding model produced ${hiddenSize} dims, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const data = hidden.data as Float32Array;

    // Mean-pool over unmasked tokens, then L2-normalize.
    const vec = new Float32Array(hiddenSize);
    let counted = 0;
    for (let i = 0; i < seq; i++) {
      if (mask[i] === 0n) continue;
      counted++;
      const off = i * hiddenSize;
      for (let j = 0; j < hiddenSize; j++) vec[j] += data[off + j];
    }
    let norm = 0;
    for (let j = 0; j < hiddenSize; j++) {
      vec[j] /= counted || 1;
      norm += vec[j] * vec[j];
    }
    norm = Math.sqrt(norm) || 1;

    const result = new Array<number>(hiddenSize);
    for (let j = 0; j < hiddenSize; j++) result[j] = vec[j] / norm;
    if (result.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding malformed (got ${result.length} values)`);
    }
    return result;
  });
}

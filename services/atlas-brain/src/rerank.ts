/**
 * Second-stage reranker for memory recall (Phase 3).
 *
 * The intended design was a small multilingual ONNX **cross-encoder** on the
 * same onnxruntime-web WASM runtime localEmbed.ts uses. Surveyed 2026-07-24,
 * no candidate clears the licence/size/latency bar:
 *
 *  - jinaai/jina-reranker-v2-base-multilingual — CC-BY-NC-4.0 (non-commercial);
 *    fails the MIT/Apache-2.0-only requirement outright.
 *  - BAAI/bge-reranker-v2-m3 — Apache-2.0, but the int8 ONNX export is ~880 MB
 *    (568M-param XLM-R-large); the WASM backend dequantizes weights on load, so
 *    that is several extra GiB of RSS on top of the ~1.4 GiB the e5 embedder
 *    already costs. Not shippable in the sidecar.
 *  - cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 — Apache-2.0, int8 ~119 MB,
 *    but mMARCO's 14 training languages do not include Danish, and scoring up
 *    to match_count*8 candidate pairs through WASM shares localEmbed's
 *    serialized inference queue — seconds added to every chat turn.
 *
 * So this is the deterministic **lexical** fallback behind the same signature:
 * BM25 term overlap over the candidate set (k1/b length normalisation) plus an
 * exact-phrase bonus, max-normalized to [0, 1]. Unlike recall's ASCII keyword
 * gate, tokenization here is Unicode-aware so Danish æ/ø/å survive. Pure
 * computation — nothing to lazy-load or tear down — and a model-backed
 * implementation can swap in behind rerankPairs() without touching any caller.
 */

const K1 = 1.2;
const B = 0.75;

/** Unicode-aware tokens, lowercased; mirrors the >=2-char convention of recall's keyword gate. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Score each doc's relevance to `query`, in [0, 1] (best candidate = 1 unless
 * nothing matches at all). Deterministic; async only so a model-backed
 * implementation can replace it behind the same signature.
 */
export async function rerankPairs(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  const qToks = [...new Set(tokenize(query))];
  if (qToks.length === 0) return docs.map(() => 0);

  const docToks = docs.map(tokenize);
  const avgLen = docToks.reduce((s, d) => s + d.length, 0) / docs.length || 1;

  // Document frequency per query term — BM25 treats the candidate set as the corpus.
  const df = new Map<string, number>();
  for (const t of qToks) {
    df.set(t, docToks.reduce((n, d) => n + (d.includes(t) ? 1 : 0), 0));
  }

  // Space-padded joins make phrase matching respect token boundaries.
  const phrase = ` ${tokenize(query).join(" ")} `;

  const scores = docs.map((_, i) => {
    const d = docToks[i];
    if (d.length === 0) return 0;
    let s = 0;
    for (const t of qToks) {
      let tf = 0;
      for (const w of d) if (w === t) tf++;
      if (tf === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / avgLen));
    }
    // The whole normalized query appearing verbatim signals much higher relevance
    // than the same terms scattered across the chunk.
    if (s > 0 && qToks.length >= 2 && ` ${d.join(" ")} `.includes(phrase)) s *= 1.3;
    return s;
  });

  const max = Math.max(...scores);
  return max > 0 ? scores.map((s) => s / max) : scores;
}

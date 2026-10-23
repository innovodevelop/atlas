import { describe, expect, test } from "bun:test";
import { TurnTimer } from "./latency.ts";
import { ScribeTokenCache } from "./stt.ts";

describe("TurnTimer", () => {
  test("reports each stage from the turn's start, and the first mark wins", () => {
    let t = 1000;
    const timer = new TurnTimer(1000, true, () => t);
    t = 1180; timer.mark("sttFinal");
    t = 1700; timer.mark("brainHeaders");
    t = 1950; timer.mark("firstToken");
    t = 2000; timer.mark("firstToken"); // a later delta doesn't move it
    t = 2310; timer.mark("firstSentence");
    t = 2620; timer.mark("firstAudio");
    expect(timer.breakdown()).toEqual({
      voice: true, sttFinal: 180, brainHeaders: 700, firstToken: 950, firstSentence: 1310, firstAudio: 1620,
    });
    expect(timer.describe()).toBe(
      "speech-end → sttFinal 180ms (+180) → brainHeaders 700ms (+520) → firstToken 950ms (+250) → firstSentence 1310ms (+360) → firstAudio 1620ms (+310)",
    );
  });

  test("a typed turn has no STT stage and a JSON reply no token stage", () => {
    let t = 0;
    const timer = new TurnTimer(0, false, () => t);
    t = 400; timer.mark("brainHeaders");
    t = 401; timer.mark("firstSentence");
    t = 900; timer.mark("firstAudio");
    expect(timer.breakdown()).toEqual({ voice: false, brainHeaders: 400, firstSentence: 401, firstAudio: 900 });
    expect(timer.describe()).toStartWith("text query → brainHeaders 400ms");
  });
});

describe("ScribeTokenCache", () => {
  function fake() {
    let n = 0;
    let fail = false;
    const minted: number[] = [];
    const mint = async () => {
      n += 1;
      minted.push(n);
      if (fail) throw new Error("401");
      return `tok${n}`;
    };
    return { mint, minted, setFail: (v: boolean) => { fail = v; } };
  }

  test("a prefetched token is handed over and the next one is minted behind it", async () => {
    const f = fake();
    const cache = new ScribeTokenCache("key", f.mint);
    cache.prefetch();
    expect(f.minted).toEqual([1]);
    expect(await cache.take()).toBe("tok1");
    expect(f.minted).toEqual([1, 2]); // the next is already on its way
    expect(await cache.take()).toBe("tok2");
  });

  test("a stale prefetched token is discarded for a fresh one", async () => {
    const f = fake();
    let now = 0;
    const cache = new ScribeTokenCache("key", f.mint, () => now);
    cache.prefetch();
    now = 11 * 60_000;
    const token = await cache.take();
    expect(token).not.toBe("tok1");
  });

  test("a failed prefetch falls back to minting inline, and errors surface", async () => {
    const f = fake();
    const cache = new ScribeTokenCache("key", f.mint);
    f.setFail(true);
    cache.prefetch();
    await Bun.sleep(0);
    await expect(cache.take()).rejects.toThrow("401");
    f.setFail(false);
    expect(await cache.take()).toMatch(/^tok/);
  });

  test("without a key nothing is minted", async () => {
    const f = fake();
    const cache = new ScribeTokenCache(undefined, f.mint);
    cache.prefetch();
    expect(f.minted).toEqual([]);
    await expect(cache.take()).rejects.toThrow("ELEVENLABS_API_KEY");
  });
});

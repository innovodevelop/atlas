import { describe, expect, test } from "bun:test";
import { keywordScore } from "./localMemory";

describe("keywordScore", () => {
  test("matches Danish words whole, not split at æ/ø/å", () => {
    expect(keywordScore("købmand", "Jeg handler i købmanden på hjørnet")).toBe(1);
    // The old ASCII split turned "købmand" into "bmand", which matched this.
    expect(keywordScore("købmand", "en gammel bmand-fil")).toBe(0);
    expect(keywordScore("blåbær æble", "blåbær og æbler")).toBe(1);
  });
  test("still ignores one-letter tokens and punctuation", () => {
    expect(keywordScore("a, b!", "a b")).toBe(0);
    expect(keywordScore("Gmail sync", "the gmail sync ran")).toBe(1);
  });
});

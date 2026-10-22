import { describe, expect, it } from "vitest";
import { contentTerms, TermCoverageReranker } from "../src/core/reranker.js";
import type { Chunk } from "../src/core/types.js";

function chunk(text: string, headingPath?: string): Chunk {
  return { id: text, documentId: "d", idx: 0, text, headingPath, tokenEstimate: 1 };
}

describe("TermCoverageReranker", () => {
  it("drops stopwords and duplicates from query terms", () => {
    expect(contentTerms("How do I set the CORS origins for the API?")).toEqual([
      "set",
      "cors",
      "origins",
      "api",
    ]);
  });

  it("scores chunks covering more query terms higher, with a heading bonus", async () => {
    const reranker = new TermCoverageReranker();
    const [all, some, heading, none] = await reranker.score("cors allowed origins", [
      chunk("set cors allowed origins in middleware"),
      chunk("cors is a browser feature"),
      chunk("cors allowed origins list", "Middleware > CORS"),
      chunk("nothing relevant here"),
    ]);

    expect(all).toBeGreaterThan(some!);
    expect(heading).toBeGreaterThan(all!);
    expect(none).toBe(0);
  });
});

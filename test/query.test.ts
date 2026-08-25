import { describe, it, expect } from "vitest";
import {
  formatDefault,
  formatExplain,
  formatJson,
} from "../src/cli/commands/query.js";
import { buildContext } from "../src/core/context.js";
import type { HybridSearchResult, RankedResult } from "../src/core/types.js";

function ranked(rank: number, id: string): RankedResult {
  return {
    chunkId: id,
    rank,
    score: 1 / (60 + rank),
    normalizedScore: rank === 1 ? 1 : 0.5,
    chunk: {
      id,
      documentId: `doc-${id}`,
      idx: 0,
      text: `text ${id}`,
      tokenEstimate: 5,
      source: `${id}.md`,
      headingPath: "Section",
    },
  };
}

function search(): HybridSearchResult {
  const results = [ranked(1, "a"), ranked(2, "b")];
  return {
    results,
    explain: {
      query: "hello",
      topK: 8,
      rrfK: 60,
      minScore: 0.3,
      dense: [
        { chunkId: "a", rank: 1, rawScore: 0.12, chunk: results[0]!.chunk },
      ],
      lexical: [
        { chunkId: "b", rank: 1, rawScore: -3.4, chunk: results[1]!.chunk },
      ],
      fused: [
        {
          chunkId: "a",
          denseRank: 1,
          lexicalRank: null,
          fusedScore: 1 / 61,
          normalizedScore: 1,
        },
        {
          chunkId: "b",
          denseRank: null,
          lexicalRank: 1,
          fusedScore: 1 / 61,
          normalizedScore: 0.5,
        },
      ],
      maxFusedScore: 1 / 61,
    },
  };
}

describe("query formatting (R4)", () => {
  it("formatDefault prints the context block and a source list", () => {
    const s = search();
    const ctx = buildContext(s.results, 4000);
    const out = formatDefault(ctx);
    expect(out).toContain("<context>");
    expect(out).toContain("sources:");
    expect(out).toContain("[1] a.md");
  });

  it("formatExplain shows both legs, RRF math, and the final context", () => {
    const s = search();
    const ctx = buildContext(s.results, 4000);
    const out = formatExplain(s, ctx);
    expect(out).toContain("dense leg (1 candidates)");
    expect(out).toContain("lexical leg (1 candidates)");
    expect(out).toContain("RRF fusion:");
    expect(out).toContain("dense#1");
    expect(out).toContain("lexical#1");
    expect(out).toContain("context:");
    expect(out).toContain("<context>");
  });

  it("formatJson emits a single valid JSON object", () => {
    const s = search();
    const ctx = buildContext(s.results, 4000);
    const out = formatJson(s, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.query).toBe("hello");
    expect(parsed.results).toHaveLength(2);
    expect(parsed.context).toContain("<context>");
    expect(parsed.explain.dense).toHaveLength(1);
    expect(parsed.explain.fused).toHaveLength(2);
  });
});

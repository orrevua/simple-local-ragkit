import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  evaluate,
  formatReportMarkdown,
  scoreCase,
  type EvalDataset,
} from "../src/core/eval.js";
import type {
  Chunk,
  HybridSearchResult,
  RankedResult,
  Retriever,
} from "../src/core/types.js";

function ranked(sources: string[]): RankedResult[] {
  return sources.map((source, i) => {
    const chunk: Chunk = {
      id: `c${i}`,
      documentId: source,
      idx: i,
      text: `text ${i}`,
      tokenEstimate: 5,
      source,
    };
    return {
      chunkId: `c${i}`,
      rank: i + 1,
      score: sources.length - i,
      normalizedScore: (sources.length - i) / sources.length,
      chunk,
    };
  });
}

/** A retriever that replays a fixed ranked source list per query. */
class FakeRetriever implements Retriever {
  constructor(private readonly byQuery: Record<string, string[]>) {}
  async hybridSearch(query: string): Promise<HybridSearchResult> {
    const results = ranked(this.byQuery[query] ?? []);
    return {
      results,
      explain: {
        query,
        topK: results.length,
        rrfK: 60,
        minScore: 0,
        dense: [],
        lexical: [],
        fused: [],
        maxFusedScore: 0,
      },
    };
  }
}

describe("scoreCase — source-anchored metrics", () => {
  it("gives a perfect score when the only relevant source is ranked first", () => {
    const m = scoreCase("q", "q", ["a.md", "b.md"], ["a.md"]);
    expect(m.hitRate).toBe(1);
    expect(m.reciprocalRank).toBe(1);
    expect(m.ndcg).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.precision).toBeCloseTo(0.5, 5);
  });

  it("discounts a relevant source that appears lower in the ranking", () => {
    const first = scoreCase("q", "q", ["a.md", "b.md"], ["a.md"]);
    const third = scoreCase("q", "q", ["x.md", "y.md", "a.md"], ["a.md"]);
    expect(third.reciprocalRank).toBeCloseTo(1 / 3, 5);
    expect(third.ndcg).toBeLessThan(first.ndcg);
  });

  it("reports a miss as all-zero", () => {
    const m = scoreCase("q", "q", ["x.md", "y.md"], ["a.md"]);
    expect(m.hitRate).toBe(0);
    expect(m.reciprocalRank).toBe(0);
    expect(m.ndcg).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.precision).toBe(0);
  });

  it("computes recall over multiple relevant sources", () => {
    const m = scoreCase("q", "q", ["a.md", "z.md", "b.md"], [
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(m.recall).toBeCloseTo(2 / 3, 5);
    expect(m.precision).toBeCloseTo(2 / 3, 5);
  });

  it("does not exceed nDCG 1 when a relevant source repeats", () => {
    const m = scoreCase("q", "q", ["a.md", "a.md"], ["a.md"]);
    expect(m.ndcg).toBeLessThanOrEqual(1);
  });
});

describe("evaluate — harness over a fake retriever (R11)", () => {
  const dataset: EvalDataset = {
    name: "golden",
    cases: [
      { id: "1", query: "hit-top", relevantSources: ["a.md"] },
      { id: "2", query: "miss", relevantSources: ["a.md"] },
    ],
  };

  it("aggregates per-case metrics into means", async () => {
    const retriever = new FakeRetriever({
      "hit-top": ["a.md", "b.md"],
      miss: ["x.md", "y.md"],
    });

    const report = await evaluate(retriever, dataset, 2);

    expect(report.aggregate.cases).toBe(2);
    expect(report.aggregate.hitRate).toBeCloseTo(0.5, 5);
    expect(report.aggregate.mrr).toBeCloseTo(0.5, 5);
    expect(report.cases[0]!.hitRate).toBe(1);
    expect(report.cases[1]!.hitRate).toBe(0);
  });

  it("renders a markdown report with a bold mean row", async () => {
    const retriever = new FakeRetriever({ "hit-top": ["a.md"], miss: [] });
    const report = await evaluate(retriever, dataset, 2);

    const md = formatReportMarkdown(report);
    expect(md).toContain("# Retrieval eval — golden (k=2)");
    expect(md).toMatch(/\*\*mean \(2\)\*\*/);
  });
});

describe("eval harness interface purity (R11)", () => {
  it("imports no concrete store/embedder implementations", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/core/eval.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/SqliteStore/);
    expect(src).not.toMatch(/OllamaEmbeddings/);
    expect(src).not.toMatch(/from ["'].*\/store\.js/);
    expect(src).not.toMatch(/from ["'].*\/embedder\.js/);
  });
});

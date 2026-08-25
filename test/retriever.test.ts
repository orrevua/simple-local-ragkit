import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { HybridRetriever } from "../src/core/retriever.js";
import { RagConfigSchema, type RagConfig } from "../src/config.js";
import type {
  Chunk,
  EmbeddingProvider,
  SearchResult,
  Store,
  StoreStats,
} from "../src/core/types.js";

function config(overrides: Partial<RagConfig["retrieval"]> = {}): RagConfig {
  const base = RagConfigSchema.parse({});
  return { ...base, retrieval: { ...base.retrieval, ...overrides } };
}

function chunk(id: string, meta?: Record<string, unknown>): Chunk {
  return {
    id,
    documentId: `doc-${id}`,
    idx: 0,
    text: `text for ${id}`,
    tokenEstimate: 5,
    source: `${id}.md`,
    metadata: meta,
  };
}

function results(...ids: Array<[string, Record<string, unknown>?]>): SearchResult[] {
  return ids.map(([id, meta], i) => ({
    chunkId: id,
    rank: i + 1,
    rawScore: i,
    chunk: chunk(id, meta),
  }));
}

class FakeStore implements Store {
  constructor(
    private readonly dense: SearchResult[],
    private readonly lexical: SearchResult[],
  ) {}
  upsertCollection(): void {}
  getDocumentBySource(): undefined {
    return undefined;
  }
  insertDocument(): void {}
  deleteDocument(): void {}
  replaceChunks(): void {}
  denseSearch(): SearchResult[] {
    return this.dense;
  }
  lexicalSearch(): SearchResult[] {
    return this.lexical;
  }
  stats(): StoreStats {
    return { documents: 0, chunks: 0 };
  }
  listCollections(): [] {
    return [];
  }
  getDocumentChunks(): [] {
    return [];
  }
}

class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake";
  readonly dimensions = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0]);
  }
}

function makeRetriever(
  dense: SearchResult[],
  lexical: SearchResult[],
  cfg: RagConfig = config({ minScore: 0 }),
): HybridRetriever {
  return new HybridRetriever({
    store: new FakeStore(dense, lexical),
    embedder: new FakeEmbedder(),
    config: cfg,
  });
}

describe("HybridRetriever RRF fusion (R2)", () => {
  it("ranks a chunk present in both legs above single-leg chunks", async () => {
    const dense = results(["a"], ["b"], ["c"]);
    const lexical = results(["b"], ["d"], ["e"]);
    const r = makeRetriever(dense, lexical);

    const { results: ranked } = await r.hybridSearch("q");

    expect(ranked[0]!.chunkId).toBe("b");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("exposes per-leg candidates and RRF math in explain", async () => {
    const dense = results(["a"], ["b"]);
    const lexical = results(["b"]);
    const r = makeRetriever(dense, lexical);

    const { explain } = await r.hybridSearch("q");

    expect(explain.dense).toHaveLength(2);
    expect(explain.lexical).toHaveLength(1);
    const bEntry = explain.fused.find((e) => e.chunkId === "b");
    expect(bEntry?.denseRank).toBe(2);
    expect(bEntry?.lexicalRank).toBe(1);
    expect(explain.maxFusedScore).toBeGreaterThan(0);
  });
});

describe("HybridRetriever metadata filter (R2)", () => {
  it("applies equality filters", async () => {
    const dense = results(["a", { ext: "md" }], ["b", { ext: "ts" }]);
    const r = makeRetriever(dense, []);

    const { results: ranked } = await r.hybridSearch("q", {
      filter: { ext: "ts" },
    });

    expect(ranked.map((x) => x.chunkId)).toEqual(["b"]);
  });

  it("applies $in filters", async () => {
    const dense = results(
      ["a", { ext: "md" }],
      ["b", { ext: "ts" }],
      ["c", { ext: "py" }],
    );
    const r = makeRetriever(dense, []);

    const { results: ranked } = await r.hybridSearch("q", {
      filter: { ext: { $in: ["md", "py"] } },
    });

    expect(ranked.map((x) => x.chunkId).sort()).toEqual(["a", "c"]);
  });
});

describe("HybridRetriever normalized minScore (R2, R6)", () => {
  it("prunes results below minScore of the top normalized result", async () => {
    // b is in both legs (high), a/c/d/e single-leg (low). With minScore 0.5
    // only the top result survives.
    const dense = results(["b"], ["a"], ["c"]);
    const lexical = results(["b"], ["d"], ["e"]);
    const r = makeRetriever(dense, lexical, config({ minScore: 0.9 }));

    const { results: ranked } = await r.hybridSearch("q");

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.chunkId).toBe("b");
    expect(ranked[0]!.normalizedScore).toBe(1);
  });

  it("respects topK", async () => {
    const dense = results(["a"], ["b"], ["c"], ["d"], ["e"]);
    const r = makeRetriever(dense, [], config({ minScore: 0, topK: 2 }));

    const { results: ranked } = await r.hybridSearch("q");

    expect(ranked).toHaveLength(2);
  });
});

describe("HybridRetriever interface purity (R11)", () => {
  it("imports no concrete store/embedder implementations", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/core/retriever.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/SqliteStore/);
    expect(src).not.toMatch(/OllamaEmbeddings/);
    expect(src).not.toMatch(/from ["'].*\/store\.js/);
    expect(src).not.toMatch(/from ["'].*\/embedder\.js/);
  });
});

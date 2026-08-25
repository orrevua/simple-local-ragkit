import type { RagConfig } from "../config.js";
import type {
  EmbeddingProvider,
  HybridExplain,
  HybridSearchOptions,
  HybridSearchResult,
  MetadataFilter,
  RankedResult,
  Retriever,
  RrfEntry,
  SearchResult,
  Store,
} from "./types.js";

export type HybridRetrieverDeps = {
  store: Store;
  embedder: EmbeddingProvider;
  config: RagConfig;
};

type FusionEntry = {
  chunkId: string;
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
  result: SearchResult;
};

function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: MetadataFilter,
): boolean {
  const meta = metadata ?? {};
  for (const [key, expected] of Object.entries(filter)) {
    const actual = meta[key];
    if (
      expected !== null &&
      typeof expected === "object" &&
      "$in" in expected
    ) {
      if (!expected.$in.includes(actual as string | number | boolean)) {
        return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Hybrid retriever: dense (vector) + lexical (BM25) legs fused with Reciprocal
 * Rank Fusion. Depends only on the abstract `Store` and `EmbeddingProvider`
 * interfaces (R11) so alternative backends can be swapped without changes here.
 */
export class HybridRetriever implements Retriever {
  private readonly store: Store;
  private readonly embedder: EmbeddingProvider;
  private readonly config: RagConfig;

  constructor(deps: HybridRetrieverDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.config = deps.config;
  }

  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<HybridSearchResult> {
    const { topK: cfgTopK, minScore, rrfK } = this.config.retrieval;
    const topK = options.topK ?? cfgTopK;
    const candidateK = topK * 3;

    const [queryVec] = await this.embedder.embed([query]);
    const dense = queryVec ? this.store.denseSearch(queryVec, candidateK) : [];
    const lexical = this.store.lexicalSearch(query, candidateK);

    const fusion = new Map<string, FusionEntry>();
    const contribute = (
      leg: SearchResult[],
      set: (e: FusionEntry, rank: number) => void,
    ): void => {
      for (const r of leg) {
        const existing = fusion.get(r.chunkId);
        const entry: FusionEntry = existing ?? {
          chunkId: r.chunkId,
          denseRank: null,
          lexicalRank: null,
          fusedScore: 0,
          result: r,
        };
        entry.fusedScore += 1 / (rrfK + r.rank);
        set(entry, r.rank);
        fusion.set(r.chunkId, entry);
      }
    };

    contribute(dense, (e, rank) => {
      e.denseRank = rank;
    });
    contribute(lexical, (e, rank) => {
      e.lexicalRank = rank;
    });

    let entries = [...fusion.values()];
    if (options.filter) {
      const filter = options.filter;
      entries = entries.filter((e) =>
        matchesFilter(e.result.chunk.metadata, filter),
      );
    }

    const maxFusedScore = entries.reduce(
      (max, e) => (e.fusedScore > max ? e.fusedScore : max),
      0,
    );

    entries.sort((a, b) => b.fusedScore - a.fusedScore);

    const results: RankedResult[] = [];
    for (const e of entries) {
      const normalizedScore =
        maxFusedScore > 0 ? e.fusedScore / maxFusedScore : 0;
      if (normalizedScore < minScore) continue;
      results.push({
        chunkId: e.chunkId,
        rank: results.length + 1,
        score: e.fusedScore,
        normalizedScore,
        chunk: e.result.chunk,
      });
      if (results.length >= topK) break;
    }

    const fused: RrfEntry[] = entries.map((e) => ({
      chunkId: e.chunkId,
      denseRank: e.denseRank,
      lexicalRank: e.lexicalRank,
      fusedScore: e.fusedScore,
      normalizedScore: maxFusedScore > 0 ? e.fusedScore / maxFusedScore : 0,
    }));

    const explain: HybridExplain = {
      query,
      topK,
      rrfK,
      minScore,
      dense,
      lexical,
      fused,
      maxFusedScore,
    };

    return { results, explain };
  }
}

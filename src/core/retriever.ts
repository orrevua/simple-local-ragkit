import type { RagConfig } from "../config.js";
import { TermCoverageReranker, type Reranker } from "./reranker.js";
import type {
  EmbeddingProvider,
  HybridExplain,
  HybridSearchOptions,
  HybridSearchResult,
  MetadataFilter,
  RankedResult,
  RerankEntry,
  RetrievalStrategy,
  Retriever,
  RrfEntry,
  SearchResult,
  Store,
} from "./types.js";

export type HybridRetrieverDeps = {
  store: Store;
  embedder: EmbeddingProvider;
  config: RagConfig;
  reranker?: Reranker;
};

/**
 * Retrieval presets, from simplest to richest. Each one is selectable with
 * `--strategy` and comparable side by side with `ragkit eval --compare`.
 */
export const RETRIEVAL_STRATEGIES: Record<
  RetrievalStrategy,
  { dense: boolean; lexical: boolean; rerank: boolean; description: string }
> = {
  dense: {
    dense: true,
    lexical: false,
    rerank: false,
    description: "vector similarity only",
  },
  lexical: {
    dense: false,
    lexical: true,
    rerank: false,
    description: "BM25 full-text only",
  },
  hybrid: {
    dense: true,
    lexical: true,
    rerank: false,
    description: "dense + BM25 fused with Reciprocal Rank Fusion",
  },
  "hybrid-rerank": {
    dense: true,
    lexical: true,
    rerank: true,
    description: "hybrid, then a reranker reorders the fused pool",
  },
};

/** How much the reranker score weighs against the normalized fused score. */
const RERANK_WEIGHT = 0.7;

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
 * Rank Fusion, optionally followed by a reranking stage. The strategy decides
 * which of those stages run. Depends only on the abstract `Store` and `EmbeddingProvider`
 * interfaces (R11) so alternative backends can be swapped without changes here.
 */
export class HybridRetriever implements Retriever {
  private readonly store: Store;
  private readonly embedder: EmbeddingProvider;
  private readonly config: RagConfig;
  private readonly reranker: Reranker;

  constructor(deps: HybridRetrieverDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.config = deps.config;
    this.reranker = deps.reranker ?? new TermCoverageReranker();
  }

  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<HybridSearchResult> {
    const { topK: cfgTopK, minScore, rrfK } = this.config.retrieval;
    const topK = options.topK ?? cfgTopK;
    const candidateK = topK * 3;
    const strategy = options.strategy ?? this.config.retrieval.strategy;
    const legs = RETRIEVAL_STRATEGIES[strategy];

    let dense: SearchResult[] = [];
    if (legs.dense) {
      const [queryVec] = await this.embedder.embed([query]);
      dense = queryVec ? this.store.denseSearch(queryVec, candidateK) : [];
    }
    const lexical = legs.lexical
      ? this.store.lexicalSearch(query, candidateK)
      : [];

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

    // Score each candidate on a 0..1 scale. Without a reranker that is just
    // the fused score normalized by the best one; with a reranker it blends
    // the reranker's opinion with the fused evidence.
    let ranked = entries.map((e) => ({
      entry: e,
      score: e.fusedScore,
      normalizedScore: maxFusedScore > 0 ? e.fusedScore / maxFusedScore : 0,
    }));

    let rerank: HybridExplain["rerank"];
    if (legs.rerank && ranked.length > 0) {
      const pool = ranked.slice(0, candidateK);
      const scores = await this.reranker.score(
        query,
        pool.map((r) => r.entry.result.chunk),
      );
      const rerankEntries: RerankEntry[] = pool.map((r, i) => {
        const finalScore =
          RERANK_WEIGHT * scores[i]! + (1 - RERANK_WEIGHT) * r.normalizedScore;
        return {
          chunkId: r.entry.chunkId,
          fusedRank: i + 1,
          rerankScore: scores[i]!,
          finalScore,
        };
      });
      ranked = pool
        .map((r, i) => ({
          entry: r.entry,
          score: rerankEntries[i]!.finalScore,
          normalizedScore: rerankEntries[i]!.finalScore,
        }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0]!.score;
      if (best > 0) {
        for (const r of ranked) r.normalizedScore = r.score / best;
      }
      rerankEntries.sort((a, b) => b.finalScore - a.finalScore);
      rerank = { reranker: this.reranker.name, entries: rerankEntries };
    }

    const results: RankedResult[] = [];
    for (const r of ranked) {
      if (r.normalizedScore < minScore) continue;
      results.push({
        chunkId: r.entry.chunkId,
        rank: results.length + 1,
        score: r.score,
        normalizedScore: r.normalizedScore,
        chunk: r.entry.result.chunk,
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
      strategy,
      topK,
      rrfK,
      minScore,
      dense,
      lexical,
      fused,
      maxFusedScore,
      ...(rerank ? { rerank } : {}),
    };

    return { results, explain };
  }
}

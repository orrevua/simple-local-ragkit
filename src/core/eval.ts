import type { Retriever } from "./types.js";

/**
 * A single golden-dataset case. Relevance is anchored to the document
 * **source** (path), not to chunk ids: chunk ids depend on the chunking
 * strategy, so a chunk-id label only stays valid for the chunker that produced
 * it. Anchoring on the source keeps the golden set comparable across chunkers
 * and reindexes.
 */
export type EvalCase = {
  id: string;
  query: string;
  relevantSources: string[];
};

export type EvalDataset = {
  name: string;
  cases: EvalCase[];
};

/** Per-case retrieval metrics at cutoff `k`. */
export type CaseMetrics = {
  id: string;
  query: string;
  hitRate: number;
  reciprocalRank: number;
  ndcg: number;
  precision: number;
  recall: number;
  retrievedSources: string[];
};

export type AggregateMetrics = {
  cases: number;
  hitRate: number;
  mrr: number;
  ndcg: number;
  precision: number;
  recall: number;
};

export type EvalReport = {
  dataset: string;
  k: number;
  cases: CaseMetrics[];
  aggregate: AggregateMetrics;
};

function dcgWeight(rank0: number): number {
  // rank0 is 0-based; the standard discount is 1 / log2(rank + 2).
  return 1 / Math.log2(rank0 + 2);
}

/**
 * Score one ranked list of retrieved sources against the relevant set. Pure and
 * deterministic — no LLM, no I/O — so it runs in CI as a hard gate.
 *
 * A relevant source counts once (nDCG/hit dedupe repeated hits of the same
 * document); precision uses the raw retrieved list.
 */
export function scoreCase(
  id: string,
  query: string,
  retrievedSources: string[],
  relevantSources: string[],
): CaseMetrics {
  const relevant = new Set(relevantSources);
  const totalRelevant = relevant.size;

  let firstRelevantRank = 0; // 1-based; 0 means "none found"
  let retrievedRelevant = 0; // raw count, for precision
  const foundSources = new Set<string>();
  const seen = new Set<string>();
  let dcg = 0;

  retrievedSources.forEach((source, i) => {
    if (!relevant.has(source)) return;
    retrievedRelevant += 1;
    if (firstRelevantRank === 0) firstRelevantRank = i + 1;
    foundSources.add(source);
    // Dedupe gains: only the first hit of a given source contributes to DCG.
    if (!seen.has(source)) {
      seen.add(source);
      dcg += dcgWeight(i);
    }
  });

  const idealHits = Math.min(totalRelevant, retrievedSources.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) idcg += dcgWeight(i);

  return {
    id,
    query,
    hitRate: firstRelevantRank > 0 ? 1 : 0,
    reciprocalRank: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
    ndcg: idcg > 0 ? dcg / idcg : 0,
    precision:
      retrievedSources.length > 0
        ? retrievedRelevant / retrievedSources.length
        : 0,
    recall: totalRelevant > 0 ? foundSources.size / totalRelevant : 0,
    retrievedSources,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Run the golden dataset through the hybrid retriever and produce a report.
 * Depends only on the abstract `Retriever` interface (R11), so any backend or a
 * fake can be evaluated without changes here.
 */
export async function evaluate(
  retriever: Retriever,
  dataset: EvalDataset,
  k: number,
): Promise<EvalReport> {
  const cases: CaseMetrics[] = [];
  for (const testCase of dataset.cases) {
    const { results } = await retriever.hybridSearch(testCase.query, {
      topK: k,
    });
    const retrievedSources = results.map(
      (r) => r.chunk.source ?? r.chunk.documentId,
    );
    cases.push(
      scoreCase(
        testCase.id,
        testCase.query,
        retrievedSources,
        testCase.relevantSources,
      ),
    );
  }

  return {
    dataset: dataset.name,
    k,
    cases,
    aggregate: {
      cases: cases.length,
      hitRate: mean(cases.map((c) => c.hitRate)),
      mrr: mean(cases.map((c) => c.reciprocalRank)),
      ndcg: mean(cases.map((c) => c.ndcg)),
      precision: mean(cases.map((c) => c.precision)),
      recall: mean(cases.map((c) => c.recall)),
    },
  };
}

/** Human-facing markdown report: a per-case table plus the aggregate row. */
export function formatReportMarkdown(report: EvalReport): string {
  const pct = (v: number): string => v.toFixed(3);
  const lines: string[] = [];
  lines.push(`# Retrieval eval — ${report.dataset} (k=${report.k})`);
  lines.push("");
  lines.push("| case | hit | RR | nDCG | precision | recall |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    lines.push(
      `| ${c.id} | ${pct(c.hitRate)} | ${pct(c.reciprocalRank)} | ` +
        `${pct(c.ndcg)} | ${pct(c.precision)} | ${pct(c.recall)} |`,
    );
  }
  const a = report.aggregate;
  lines.push(
    `| **mean (${a.cases})** | **${pct(a.hitRate)}** | **${pct(a.mrr)}** | ` +
      `**${pct(a.ndcg)}** | **${pct(a.precision)}** | **${pct(a.recall)}** |`,
  );
  return lines.join("\n");
}

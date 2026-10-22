import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadConfig } from "../../config.js";
import { createEmbedder } from "../../core/providers.js";
import {
  evaluate,
  formatReportMarkdown,
  type EvalDataset,
  type EvalReport,
} from "../../core/eval.js";
import { EvalDatasetError } from "../../core/errors.js";
import {
  HybridRetriever,
  RETRIEVAL_STRATEGIES,
} from "../../core/retriever.js";
import type { RetrievalStrategy } from "../../core/types.js";
import { openStore } from "./ingest.js";

export type EvalCommandOptions = {
  collection?: string;
  topK?: number;
  json?: boolean;
  strategy?: RetrievalStrategy;
  compare?: boolean;
};

const DatasetSchema = z.object({
  name: z.string().default("golden"),
  cases: z
    .array(
      z.object({
        id: z.string(),
        query: z.string(),
        relevantSources: z.array(z.string()).nonempty(),
      }),
    )
    .nonempty(),
});

/** Load and validate a golden dataset JSON file. */
export function loadDataset(datasetPath: string): EvalDataset {
  let raw: string;
  try {
    raw = readFileSync(datasetPath, "utf8");
  } catch (cause) {
    throw new EvalDatasetError(
      `Cannot read golden dataset at ${datasetPath}.`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new EvalDatasetError(
      `Golden dataset at ${datasetPath} is not valid JSON.`,
      { cause },
    );
  }

  const result = DatasetSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new EvalDatasetError(
      `Invalid golden dataset at ${datasetPath}:\n${issues}`,
    );
  }
  return result.data;
}

export async function runEval(
  cwd: string,
  datasetPath: string,
  options: EvalCommandOptions,
): Promise<void> {
  const config = await loadConfig(cwd);
  const dataset = loadDataset(datasetPath);
  const k = options.topK ?? config.retrieval.topK;

  const { db, store } = openStore(config.dbPath);
  try {
    const embedder = createEmbedder(config, db);
    const retriever = new HybridRetriever({ store, embedder, config });

    if (options.compare) {
      const strategies = Object.keys(RETRIEVAL_STRATEGIES) as RetrievalStrategy[];
      const reports: Array<{ strategy: RetrievalStrategy; report: EvalReport }> = [];
      for (const strategy of strategies) {
        const report = await evaluate(retriever, dataset, k, { strategy });
        reports.push({ strategy, report });
      }
      const output = options.json
        ? JSON.stringify(reports, null, 2)
        : formatComparisonMarkdown(dataset.name, k, embedder.model, reports);
      process.stdout.write(`${output}\n`);
      return;
    }

    const report = await evaluate(retriever, dataset, k, {
      strategy: options.strategy,
    });

    const output = options.json
      ? JSON.stringify(report, null, 2)
      : formatReportMarkdown(report);
    process.stdout.write(`${output}\n`);
  } finally {
    db.close();
  }
}

/**
 * One row per strategy, aggregate metrics only, so the effect of each
 * retrieval stage is visible at a glance.
 */
export function formatComparisonMarkdown(
  datasetName: string,
  k: number,
  embedModel: string,
  reports: Array<{ strategy: RetrievalStrategy; report: EvalReport }>,
): string {
  const f = (v: number): string => v.toFixed(3);
  const lines = [
    `# Strategy comparison — ${datasetName} (k=${k}, embeddings: ${embedModel})`,
    "",
    "| strategy | what it does | hit | MRR | nDCG | precision | recall |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { strategy, report } of reports) {
    const a = report.aggregate;
    lines.push(
      `| ${strategy} | ${RETRIEVAL_STRATEGIES[strategy].description} | ` +
        `${f(a.hitRate)} | ${f(a.mrr)} | ${f(a.ndcg)} | ${f(a.precision)} | ${f(a.recall)} |`,
    );
  }
  return lines.join("\n");
}

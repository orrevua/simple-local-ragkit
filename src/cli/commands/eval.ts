import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadConfig } from "../../config.js";
import { OllamaEmbeddings } from "../../core/embedder.js";
import {
  evaluate,
  formatReportMarkdown,
  type EvalDataset,
} from "../../core/eval.js";
import { EvalDatasetError } from "../../core/errors.js";
import { HybridRetriever } from "../../core/retriever.js";
import { openStore } from "./ingest.js";

export type EvalCommandOptions = {
  collection?: string;
  topK?: number;
  json?: boolean;
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
    const embedder = new OllamaEmbeddings(db, {
      model: config.embeddings.model,
      baseUrl: config.embeddings.baseUrl,
    });
    const retriever = new HybridRetriever({ store, embedder, config });

    const report = await evaluate(retriever, dataset, k);

    const output = options.json
      ? JSON.stringify(report, null, 2)
      : formatReportMarkdown(report);
    process.stdout.write(`${output}\n`);
  } finally {
    db.close();
  }
}

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { DimensionMismatchError } from "../../core/errors.js";
import * as log from "../../core/logger.js";
import { openStore } from "./ingest.js";
import { expandDbPath } from "../db-path.js";

const DEFAULT_COLLECTION = "pessoal";
const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://localhost:11434";
const EMBED_DIMENSIONS = 768;

export type InitOptions = {
  force?: boolean;
};

export type InitAnswers = {
  roots: string[];
  collection: string;
  model: string;
};

export type ConfigOptions = {
  roots: string[];
  collection: string;
  model: string;
  baseUrl?: string;
};

function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/**
 * Render a `ragkit.config.ts` source string via `defineConfig({...})`, filling
 * §7 defaults (dbPath `~/.ragkit/<collection>.db`, embeddings, chunking,
 * retrieval). Pure and deterministic so it can be tested in isolation.
 */
export function renderConfig(opts: ConfigOptions): string {
  const roots = opts.roots.map(toPosix);
  const baseUrl = opts.baseUrl ? `    baseUrl: ${JSON.stringify(opts.baseUrl)},\n` : "";
  const rootsBlock =
    roots.length === 0
      ? "[]"
      : `[\n${roots.map((r) => `    ${JSON.stringify(r)},`).join("\n")}\n  ]`;

  return `import { defineConfig } from "ragkit";

export default defineConfig({
  collection: ${JSON.stringify(opts.collection)},
  dbPath: ${JSON.stringify(`~/.ragkit/${opts.collection}.db`)},
  roots: ${rootsBlock},
  embeddings: {
    provider: "ollama",
    model: ${JSON.stringify(opts.model)},
${baseUrl}  },
  chunking: {
    size: 800,
    overlap: 120,
  },
  retrieval: {
    topK: 8,
    minScore: 0.3,
    contextTokens: 4000,
    rrfK: 60,
  },
  ignore: [],
});
`;
}

function parseRoots(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function prompt(opts: InitOptions): Promise<InitAnswers> {
  const defaults: InitAnswers = {
    roots: [],
    collection: DEFAULT_COLLECTION,
    model: DEFAULT_MODEL,
  };

  if (!process.stdin.isTTY) {
    log.warn(
      "stdin is not a TTY; using defaults (no roots, collection " +
        `"${DEFAULT_COLLECTION}", model "${DEFAULT_MODEL}").`,
    );
    return defaults;
  }

  void opts;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const rootsRaw = await rl.question(
      "Which folders are part of your personal knowledge base?\n" +
        "(transversal notes/specs/docs OUTSIDE this project, comma-separated): ",
    );
    const collectionRaw = await rl.question(
      `Collection name [${DEFAULT_COLLECTION}]: `,
    );
    const modelRaw = await rl.question(`Embed model [${DEFAULT_MODEL}]: `);

    return {
      roots: parseRoots(rootsRaw),
      collection: collectionRaw.trim() || DEFAULT_COLLECTION,
      model: modelRaw.trim() || DEFAULT_MODEL,
    };
  } finally {
    rl.close();
  }
}

export type FetchLike = (
  input: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function checkOllama(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike,
): Promise<void> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${baseUrl}/api/tags`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Ollama unreachable at ${baseUrl} (${message}). Run \`ollama serve\`.`);
    return;
  }
  if (!res.ok) {
    log.warn(`${baseUrl}/api/tags returned ${res.status}.`);
    return;
  }

  let tags: { models?: Array<{ name?: string }> };
  try {
    tags = (await res.json()) as typeof tags;
  } catch {
    tags = {};
  }
  const names = (tags.models ?? []).map((m) => m.name ?? "");
  const pulled = names.some((n) => n === model || n.startsWith(`${model}:`));
  if (!pulled) {
    log.warn(`Embed model "${model}" not found. Run \`ollama pull ${model}\`.`);
  }
}

/**
 * Create (or recreate under `--force`) the collection row at `dbPath`. `--force`
 * deletes the collection's documents (chunks/vec/fts cascade via
 * `deleteDocument`) and rewrites the collection row with the new dimensions,
 * bypassing the `DimensionMismatchError` guard. Without `--force`, an existing
 * collection whose dimensions differ throws `DimensionMismatchError`.
 */
export function createCollectionDb(
  dbPath: string,
  collection: string,
  model: string,
  options: InitOptions,
): void {
  const { db, store } = openStore(dbPath);
  try {
    const existing = db
      .prepare("SELECT dimensions FROM collections WHERE name = ?")
      .get(collection) as { dimensions: number } | undefined;

    if (
      existing &&
      existing.dimensions !== EMBED_DIMENSIONS &&
      !options.force
    ) {
      throw new DimensionMismatchError(existing.dimensions, EMBED_DIMENSIONS, model);
    }

    if (existing && options.force) {
      const docs = db
        .prepare("SELECT id FROM documents WHERE collection = ?")
        .all(collection) as Array<{ id: string }>;
      for (const { id } of docs) store.deleteDocument(id);
    }

    store.upsertCollection(collection, EMBED_DIMENSIONS, model);
  } finally {
    db.close();
  }
}

export async function runInit(
  cwd: string,
  options: InitOptions,
): Promise<void> {
  const configPath = path.join(cwd, "ragkit.config.ts");
  if (existsSync(configPath) && !options.force) {
    throw new Error(
      `${configPath} already exists. Use \`ragkit init --force\` to overwrite.`,
    );
  }

  const answers = await prompt(options);
  const source = renderConfig({
    roots: answers.roots,
    collection: answers.collection,
    model: answers.model,
  });

  await checkOllama(
    DEFAULT_BASE_URL,
    answers.model,
    fetch as unknown as FetchLike,
  );

  const dbPath = expandDbPath(`~/.ragkit/${answers.collection}.db`);
  createCollectionDb(dbPath, answers.collection, answers.model, options);
  log.success(`Created collection "${answers.collection}" at ${dbPath}`);

  writeFileSync(configPath, source, "utf8");
  log.success(`Wrote ${configPath}`);
}

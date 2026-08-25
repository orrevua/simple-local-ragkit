import { loadConfig, type RagConfig } from "../../config.js";
import { expandDbPath } from "../db-path.js";
import * as log from "../../core/logger.js";
import pc from "picocolors";
import { openDb } from "../../core/store.js";
import { existsSync } from "node:fs";

const DEFAULT_BASE_URL = "http://localhost:11434";

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function checkOllama(
  config: RagConfig,
  fetchImpl: FetchLike,
): Promise<{ reachable: CheckResult; model: CheckResult }> {
  const baseUrl = config.embeddings.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.embeddings.model;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${baseUrl}/api/tags`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: {
        name: "ollama reachable",
        ok: false,
        detail: `${baseUrl} unreachable (${message}). Run \`ollama serve\`.`,
      },
      model: {
        name: "embed model pulled",
        ok: false,
        detail: "skipped: Ollama unreachable.",
      },
    };
  }

  if (!res.ok) {
    return {
      reachable: {
        name: "ollama reachable",
        ok: false,
        detail: `${baseUrl}/api/tags returned ${res.status}.`,
      },
      model: {
        name: "embed model pulled",
        ok: false,
        detail: "skipped: Ollama unreachable.",
      },
    };
  }

  const reachable: CheckResult = {
    name: "ollama reachable",
    ok: true,
    detail: baseUrl,
  };

  let tags: { models?: Array<{ name?: string }> };
  try {
    tags = (await res.json()) as typeof tags;
  } catch {
    tags = {};
  }
  const names = (tags.models ?? []).map((m) => m.name ?? "");
  const pulled = names.some((n) => n === model || n.startsWith(`${model}:`));
  return {
    reachable,
    model: {
      name: "embed model pulled",
      ok: pulled,
      detail: pulled
        ? model
        : `model "${model}" not found. Run \`ollama pull ${model}\`.`,
    },
  };
}

function checkDb(config: RagConfig): CheckResult {
  const dbPath = config.dbPath;
  try {
    const resolved = expandDbPath(dbPath);
    if (!existsSync(resolved)) {
      return {
        name: "database integrity",
        ok: false,
        detail: `${resolved} does not exist. Run \`ragkit init\` first.`,
      };
    }

    const db = openDb(resolved);
    try {
      const row = db.pragma("integrity_check", { simple: true }) as string;
      if (row !== "ok") {
        return {
          name: "database integrity",
          ok: false,
          detail: `PRAGMA integrity_check reported: ${row}`,
        };
      }
      return {
        name: "database integrity",
        ok: true,
        detail: `${resolved} (integrity ok)`,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "database integrity",
      ok: false,
      detail: `${dbPath}: ${message}`,
    };
  }
}

export async function runChecks(
  config: RagConfig,
  fetchImpl: FetchLike,
): Promise<CheckResult[]> {
  const { reachable, model } = await checkOllama(config, fetchImpl);
  return [reachable, model, checkDb(config)];
}

export async function runDoctor(cwd: string): Promise<number> {
  const config = await loadConfig(cwd);
  const results = await runChecks(config, fetch as unknown as FetchLike);

  for (const r of results) {
    const mark = r.ok ? pc.green("PASS") : pc.red("FAIL");
    process.stderr.write(`[${mark}] ${r.name}: ${r.detail}\n`);
  }

  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    log.error(`${failed} check(s) failed.`);
    return 1;
  }
  log.success("All checks passed.");
  return 0;
}

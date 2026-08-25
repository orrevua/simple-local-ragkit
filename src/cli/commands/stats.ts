import { statSync } from "node:fs";
import { loadConfig } from "../../config.js";
import { openStore } from "./ingest.js";
import { expandDbPath } from "../db-path.js";

export type StatsCommandOptions = {
  collection?: string;
};

export type StatsReport = {
  collection: string;
  documents: number;
  chunks: number;
  dbBytes: number;
  embedModel: string | null;
  lastIngest: number | null;
};

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function computeStats(
  dbPath: string,
  collection: string,
): StatsReport {
  const resolved = expandDbPath(dbPath);
  const { db, store } = openStore(dbPath);
  try {
    const { documents, chunks } = store.stats();
    const meta = db
      .prepare("SELECT embed_model FROM collections WHERE name = ?")
      .get(collection) as { embed_model: string | null } | undefined;
    const last = db
      .prepare(
        "SELECT max(created_at) AS ts FROM documents WHERE collection = ?",
      )
      .get(collection) as { ts: number | null };
    const dbBytes = statSync(resolved).size;
    return {
      collection,
      documents,
      chunks,
      dbBytes,
      embedModel: meta?.embed_model ?? null,
      lastIngest: last.ts ?? null,
    };
  } finally {
    db.close();
  }
}

export async function runStats(
  cwd: string,
  options: StatsCommandOptions,
): Promise<void> {
  const config = await loadConfig(cwd);
  const collection = options.collection ?? config.collection;
  const report = computeStats(config.dbPath, collection);

  const lastIngest =
    report.lastIngest === null
      ? "never"
      : new Date(report.lastIngest).toISOString();

  const lines = [
    `collection:  ${report.collection}`,
    `documents:   ${report.documents}`,
    `chunks:      ${report.chunks}`,
    `db size:     ${formatBytes(report.dbBytes)}`,
    `embed model: ${report.embedModel ?? "unknown"}`,
    `last ingest: ${lastIngest}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

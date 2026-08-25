import { loadConfig } from "../../config.js";
import { ingest, type IngestResult } from "../../core/ingest.js";
import {
  loadVecExtension,
  migrate,
  openDb,
  SqliteStore,
  type Db,
} from "../../core/store.js";
import { OllamaEmbeddings } from "../../core/embedder.js";
import { resolveRoots } from "../../core/loaders.js";
import { watchRoots, type WatchEvent } from "../../core/watch.js";
import * as log from "../../core/logger.js";
import { expandDbPath } from "../db-path.js";

export type IngestCommandOptions = {
  collection?: string;
  watch?: boolean;
};

export function formatTally(r: IngestResult): string {
  const seconds = (r.ms / 1000).toFixed(1);
  return (
    `${r.added} added, ${r.updated} updated, ` +
    `${r.unchanged} unchanged, ${r.removed} removed — ${seconds}s`
  );
}

export function openStore(dbPath: string): { db: Db; store: SqliteStore } {
  const db = openDb(expandDbPath(dbPath));
  loadVecExtension(db);
  migrate(db);
  return { db, store: new SqliteStore(db) };
}

export async function runIngest(
  cwd: string,
  targetPath: string | undefined,
  options: IngestCommandOptions,
): Promise<void> {
  const config = await loadConfig(cwd);
  const collection = options.collection ?? config.collection;

  const { db, store } = openStore(config.dbPath);
  const embedder = new OllamaEmbeddings(db, {
    model: config.embeddings.model,
    baseUrl: config.embeddings.baseUrl,
  });

  const paths = targetPath ? [targetPath] : undefined;
  log.info(
    `Ingesting ${paths ? paths.join(", ") : config.roots.join(", ")} ` +
      `into collection "${collection}"`,
  );

  try {
    const result = await ingest({ store, embedder, config, paths, collection });
    log.success(formatTally(result));

    for (const err of result.errors) {
      log.warn(`${err.source}: ${err.message}`);
    }
  } catch (err) {
    db.close();
    throw err;
  }

  if (!options.watch) {
    db.close();
    return;
  }

  const roots = resolveRoots(paths ?? config.roots);
  const handle = watchRoots({
    roots,
    config,
    store,
    embedder,
    collection,
    onEvent: logWatchEvent,
  });

  log.success(`Watching ${roots.join(", ")} for changes (Ctrl+C to stop).`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().finally(() => {
        db.close();
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function logWatchEvent(event: WatchEvent): void {
  switch (event.type) {
    case "reindexed":
      if (event.added > 0 || event.updated > 0) {
        log.success(`reindexed ${event.source}`);
      }
      break;
    case "removed":
      log.success(`removed ${event.source}`);
      break;
    case "error":
      log.warn(`${event.source}: ${event.message}`);
      break;
  }
}

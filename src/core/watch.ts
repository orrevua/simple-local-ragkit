import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { RagConfig } from "../config.js";
import { ingest } from "./ingest.js";
import { resolveRoots } from "./loaders.js";
import type { EmbeddingProvider, Store } from "./types.js";

export type WatchEvent =
  | { type: "reindexed"; source: string; added: number; updated: number }
  | { type: "removed"; source: string }
  | { type: "error"; source: string; message: string };

export type WatchContext = {
  roots: string[];
  config: RagConfig;
  store: Store;
  embedder: EmbeddingProvider;
  collection: string;
  onEvent?: (event: WatchEvent) => void;
};

export type WatchHandle = {
  close(): Promise<void>;
};

const DEBOUNCE_MS = 500;

/** Absolute roots the changed path may fall under, matching stored `source`. */
function resolveSource(ctx: WatchContext, absPath: string): string | undefined {
  const abs = path.resolve(absPath);
  for (const root of ctx.roots) {
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return rel.split(path.sep).join("/");
    }
  }
  return undefined;
}

/**
 * Reindex a single changed file by scoping `ingest` to just that path, so its
 * added/updated logic and removal-scoping apply to the one file only — never the
 * whole tree.
 */
export async function reindexFile(
  ctx: WatchContext,
  absPath: string,
): Promise<void> {
  const source = resolveSource(ctx, absPath) ?? absPath;
  try {
    const result = await ingest({
      store: ctx.store,
      embedder: ctx.embedder,
      config: ctx.config,
      paths: [absPath],
      collection: ctx.collection,
      pruneRemoved: false,
    });
    if (result.errors.length > 0) {
      ctx.onEvent?.({
        type: "error",
        source,
        message: result.errors[0]!.message,
      });
      return;
    }
    ctx.onEvent?.({
      type: "reindexed",
      source,
      added: result.added,
      updated: result.updated,
    });
  } catch (err) {
    ctx.onEvent?.({
      type: "error",
      source,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove the document for a deleted file by its root-relative `source`. */
export function removeFile(ctx: WatchContext, absPath: string): void {
  const source = resolveSource(ctx, absPath);
  if (!source) return;
  try {
    const doc = ctx.store.getDocumentBySource(ctx.collection, source);
    if (!doc) return;
    ctx.store.deleteDocument(doc.id);
    ctx.onEvent?.({ type: "removed", source });
  } catch (err) {
    ctx.onEvent?.({
      type: "error",
      source,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Watch the resolved ingested roots. On add/change, reindex only the changed
 * file; on unlink, remove its document. Changes are debounced (500ms) and
 * processed serially per path so overlapping embeds never interleave.
 */
export function watchRoots(ctx: WatchContext): WatchHandle {
  const roots = ctx.roots.length > 0 ? ctx.roots : resolveRoots(ctx.config.roots);
  const active: WatchContext = { ...ctx, roots };

  const timers = new Map<string, NodeJS.Timeout>();
  let queue: Promise<void> = Promise.resolve();

  const schedule = (absPath: string, action: () => Promise<void>): void => {
    const key = path.resolve(absPath);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        queue = queue.then(action);
      }, DEBOUNCE_MS),
    );
  };

  const watcher: FSWatcher = chokidar.watch(roots, {
    ignoreInitial: true,
    persistent: true,
  });

  watcher
    .on("add", (p) => schedule(p, () => reindexFile(active, p)))
    .on("change", (p) => schedule(p, () => reindexFile(active, p)))
    .on("unlink", (p) =>
      schedule(p, async () => {
        removeFile(active, p);
      }),
    );

  return {
    async close(): Promise<void> {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await queue;
      await watcher.close();
    },
  };
}

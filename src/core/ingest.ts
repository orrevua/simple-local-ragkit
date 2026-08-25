import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RagConfig } from "../config.js";
import { chunkFile } from "./chunker.js";
import { loadFiles, resolveRoots } from "./loaders.js";
import type { Db } from "./store.js";
import type { Chunk, EmbeddingProvider, Store } from "./types.js";

export type IngestOptions = {
  store: Store;
  embedder: EmbeddingProvider;
  config: RagConfig;
  paths?: string[];
  collection?: string;
  pruneRemoved?: boolean;
};

export type IngestError = {
  source: string;
  message: string;
};

export type IngestResult = {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  ms: number;
  errors: IngestError[];
};

type WithDb = { db: Db };

function hasDb(store: Store): store is Store & WithDb {
  return "db" in store && Boolean((store as WithDb).db);
}

function isUnder(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A stored `source` is root-relative to whichever configured root produced it.
 * Reconstruct its absolute path by choosing the config root under which the file
 * actually exists (disambiguating identical basenames across roots), falling
 * back to any non-escaping root for files already deleted from disk. Only
 * documents whose absolute path lies under an actually-ingested root may be
 * flagged as removed, so partial ingests never delete unrelated collection
 * documents (I6 removal-scoping fix).
 */
function resolveSourceAbs(
  source: string,
  configRoots: string[],
): string | undefined {
  const candidates = configRoots
    .map((root) => path.resolve(root, source))
    .filter((abs, i) => isUnder(configRoots[i]!, abs));
  if (candidates.length === 0) return undefined;
  return candidates.find(existsSync) ?? candidates[0];
}

function isUnderIngestedRoot(
  source: string,
  ingestedRoots: string[],
  configRoots: string[],
): boolean {
  const abs = resolveSourceAbs(source, configRoots);
  if (!abs) return false;
  return ingestedRoots.some((root) => isUnder(root, abs));
}

function listSources(store: Store, collection: string): string[] {
  if (!hasDb(store)) return [];
  const rows = store.db
    .prepare("SELECT source FROM documents WHERE collection = ?")
    .all(collection) as Array<{ source: string }>;
  return rows.map((r) => r.source);
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const started = Date.now();
  const collection = opts.collection ?? opts.config.collection;
  const inputs =
    opts.paths && opts.paths.length > 0 ? opts.paths : opts.config.roots;

  const files = loadFiles(inputs, opts.config);
  const ingestedRoots = resolveRoots(inputs);
  const configRoots = resolveRoots(opts.config.roots);

  opts.store.upsertCollection(
    collection,
    opts.embedder.dimensions,
    opts.embedder.model,
  );

  const result: IngestResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    ms: 0,
    errors: [],
  };

  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file.source);
    try {
      const existing = opts.store.getDocumentBySource(collection, file.source);
      if (existing && existing.contentHash === file.contentHash) {
        result.unchanged += 1;
        continue;
      }

      if (existing) opts.store.deleteDocument(existing.id);

      const documentId = randomUUID();
      const drafts = chunkFile(
        { ext: file.ext, content: file.content },
        opts.config.chunking,
      );
      const chunks: Chunk[] = drafts.map((d) => ({
        id: randomUUID(),
        documentId,
        idx: d.idx,
        text: d.text,
        headingPath: d.headingPath,
        startLine: d.startLine,
        endLine: d.endLine,
        tokenEstimate: d.tokenEstimate,
      }));
      const embeddings = await opts.embedder.embed(chunks.map((c) => c.text));

      opts.store.insertDocument({
        id: documentId,
        collection,
        source: file.source,
        contentHash: file.contentHash,
        metadata: file.metadata,
        mtime: file.mtime,
        createdAt: existing?.createdAt ?? Date.now(),
      });
      opts.store.replaceChunks(documentId, chunks, embeddings);

      if (existing) result.updated += 1;
      else result.added += 1;
    } catch (err) {
      result.errors.push({
        source: file.source,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.pruneRemoved !== false) {
    for (const source of listSources(opts.store, collection)) {
      if (seen.has(source)) continue;
      if (!isUnderIngestedRoot(source, ingestedRoots, configRoots)) continue;
      const doc = opts.store.getDocumentBySource(collection, source);
      if (doc) {
        opts.store.deleteDocument(doc.id);
        result.removed += 1;
      }
    }
  }

  result.ms = Date.now() - started;
  return result;
}

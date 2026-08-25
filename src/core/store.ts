import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { VecExtensionError } from "./errors.js";
import type {
  Chunk,
  CollectionSummary,
  Document,
  SearchResult,
  Store,
  StoreStats,
} from "./types.js";

export { VecExtensionError };

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

export function openDb(path: string): Db {
  return new Database(path);
}

export function loadVecExtension(db: Db): void {
  try {
    loadSqliteVec(db);
  } catch (cause) {
    throw new VecExtensionError(cause);
  }
}

export function migrate(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY,
      dimensions INTEGER,
      embed_model TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      collection TEXT,
      source TEXT,
      content_hash TEXT,
      metadata TEXT,
      mtime INTEGER,
      created_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_source
      ON documents(collection, source);

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
      idx INTEGER,
      text TEXT,
      heading_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      token_estimate INTEGER,
      metadata TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, content='chunks', content_rowid='rowid');

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
      USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768]);

    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY,
      model TEXT,
      embedding BLOB,
      created_at INTEGER
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

type ChunkRow = {
  id: string;
  document_id: string;
  idx: number;
  text: string;
  heading_path: string | null;
  start_line: number | null;
  end_line: number | null;
  token_estimate: number;
  source?: string | null;
  doc_metadata?: string | null;
};

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    documentId: row.document_id,
    idx: row.idx,
    text: row.text,
    headingPath: row.heading_path ?? undefined,
    startLine: row.start_line ?? undefined,
    endLine: row.end_line ?? undefined,
    tokenEstimate: row.token_estimate,
    source: row.source ?? undefined,
    metadata:
      row.doc_metadata != null ? JSON.parse(row.doc_metadata) : undefined,
  };
}

function f32Blob(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

export class SqliteStore implements Store {
  constructor(readonly db: Db) {}

  upsertCollection(name: string, dimensions: number, embedModel: string): void {
    this.db
      .prepare(
        `INSERT INTO collections(name, dimensions, embed_model, created_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           dimensions = excluded.dimensions,
           embed_model = excluded.embed_model`,
      )
      .run(name, dimensions, embedModel, Date.now());
  }

  getDocumentBySource(
    collection: string,
    source: string,
  ): Document | undefined {
    const row = this.db
      .prepare(
        `SELECT id, collection, source, content_hash, metadata, mtime, created_at
           FROM documents WHERE collection = ? AND source = ?`,
      )
      .get(collection, source) as
      | {
          id: string;
          collection: string;
          source: string;
          content_hash: string;
          metadata: string | null;
          mtime: number;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      collection: row.collection,
      source: row.source,
      contentHash: row.content_hash,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      mtime: row.mtime,
      createdAt: row.created_at,
    };
  }

  insertDocument(doc: Document): void {
    this.db
      .prepare(
        `INSERT INTO documents(id, collection, source, content_hash, metadata, mtime, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        doc.id,
        doc.collection,
        doc.source,
        doc.contentHash,
        JSON.stringify(doc.metadata ?? {}),
        doc.mtime,
        doc.createdAt,
      );
  }

  deleteDocument(id: string): void {
    const tx = this.db.transaction((docId: string) => {
      const chunkIds = this.db
        .prepare("SELECT id FROM chunks WHERE document_id = ?")
        .all(docId) as Array<{ id: string }>;
      const delVec = this.db.prepare(
        "DELETE FROM chunks_vec WHERE chunk_id = ?",
      );
      for (const { id: chunkId } of chunkIds) {
        delVec.run(chunkId);
      }
      this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
    });
    tx(id);
  }

  replaceChunks(
    documentId: string,
    chunks: Chunk[],
    embeddings: number[][],
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `replaceChunks: chunks (${chunks.length}) and embeddings (${embeddings.length}) length mismatch`,
      );
    }

    const tx = this.db.transaction(() => {
      const oldIds = this.db
        .prepare("SELECT id FROM chunks WHERE document_id = ?")
        .all(documentId) as Array<{ id: string }>;
      const delVec = this.db.prepare(
        "DELETE FROM chunks_vec WHERE chunk_id = ?",
      );
      for (const { id } of oldIds) {
        delVec.run(id);
      }
      this.db
        .prepare("DELETE FROM chunks WHERE document_id = ?")
        .run(documentId);

      const insChunk = this.db.prepare(
        `INSERT INTO chunks(id, document_id, idx, text, heading_path, start_line, end_line, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insVec = this.db.prepare(
        "INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)",
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        insChunk.run(
          c.id,
          documentId,
          c.idx,
          c.text,
          c.headingPath ?? null,
          c.startLine ?? null,
          c.endLine ?? null,
          c.tokenEstimate,
        );
        insVec.run(c.id, f32Blob(embeddings[i]!));
      }
    });
    tx();
  }

  denseSearch(queryVec: number[], k: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT v.chunk_id AS chunk_id, v.distance AS distance,
                c.id, c.document_id, c.idx, c.text, c.heading_path,
                c.start_line, c.end_line, c.token_estimate,
                d.source AS source, d.metadata AS doc_metadata
           FROM chunks_vec v
           JOIN chunks c ON c.id = v.chunk_id
           JOIN documents d ON d.id = c.document_id
          WHERE v.embedding MATCH ? AND k = ?
          ORDER BY v.distance`,
      )
      .all(f32Blob(queryVec), k) as Array<ChunkRow & { distance: number }>;
    return rows.map((row, i) => ({
      chunkId: row.id,
      rank: i + 1,
      rawScore: row.distance,
      chunk: rowToChunk(row),
    }));
  }

  lexicalSearch(query: string, k: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.idx, c.text, c.heading_path,
                c.start_line, c.end_line, c.token_estimate,
                d.source AS source, d.metadata AS doc_metadata,
                bm25(chunks_fts) AS score
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN documents d ON d.id = c.document_id
          WHERE chunks_fts MATCH ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(query, k) as Array<ChunkRow & { score: number }>;
    return rows.map((row, i) => ({
      chunkId: row.id,
      rank: i + 1,
      rawScore: row.score,
      chunk: rowToChunk(row),
    }));
  }

  stats(): StoreStats {
    const docs = this.db
      .prepare("SELECT count(*) AS n FROM documents")
      .get() as { n: number };
    const chunks = this.db
      .prepare("SELECT count(*) AS n FROM chunks")
      .get() as { n: number };
    return { documents: docs.n, chunks: chunks.n };
  }

  listCollections(): CollectionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.name AS name,
                count(DISTINCT d.id) AS documents,
                count(ch.id) AS chunks
           FROM collections c
           LEFT JOIN documents d ON d.collection = c.name
           LEFT JOIN chunks ch ON ch.document_id = d.id
          GROUP BY c.name
          ORDER BY c.name`,
      )
      .all() as Array<{ name: string; documents: number; chunks: number }>;
    return rows.map((r) => ({
      name: r.name,
      documents: r.documents,
      chunks: r.chunks,
    }));
  }

  getDocumentChunks(documentId: string): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.idx, c.text, c.heading_path,
                c.start_line, c.end_line, c.token_estimate,
                d.source AS source, d.metadata AS doc_metadata
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.document_id = ?
          ORDER BY c.idx`,
      )
      .all(documentId) as ChunkRow[];
    return rows.map(rowToChunk);
  }
}

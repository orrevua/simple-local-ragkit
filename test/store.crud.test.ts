import { describe, it, expect, afterEach } from "vitest";
import {
  openDb,
  loadVecExtension,
  migrate,
  SqliteStore,
  type Db,
} from "../src/core/store.js";
import type { Chunk, Document } from "../src/core/types.js";

let db: Db | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function newStore(): SqliteStore {
  db = openDb(":memory:");
  loadVecExtension(db);
  migrate(db);
  return new SqliteStore(db);
}

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1",
    collection: "pessoal",
    source: "notas/a.md",
    contentHash: "hash-1",
    metadata: { ext: "md" },
    mtime: 1000,
    createdAt: 2000,
    ...overrides,
  };
}

function chunk(id: string, idx: number, text: string): Chunk {
  return { id, documentId: "doc-1", idx, text, tokenEstimate: text.length };
}

function vec(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === seed ? 1 : 0));
}

function ftsCount(d: Db, term: string): number {
  const row = d
    .prepare(
      "SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?",
    )
    .get(term) as { n: number };
  return row.n;
}

function vecCount(d: Db): number {
  const row = d.prepare("SELECT count(*) AS n FROM chunks_vec").get() as {
    n: number;
  };
  return row.n;
}

describe("SqliteStore CRUD (B4)", () => {
  it("upsertCollection inserts and updates", () => {
    const store = newStore();
    store.upsertCollection("pessoal", 768, "nomic-embed-text");
    store.upsertCollection("pessoal", 768, "other-model");
    const row = db!
      .prepare("SELECT embed_model FROM collections WHERE name = ?")
      .get("pessoal") as { embed_model: string };
    expect(row.embed_model).toBe("other-model");
  });

  it("insertDocument then getDocumentBySource round-trips", () => {
    const store = newStore();
    store.insertDocument(doc());
    const found = store.getDocumentBySource("pessoal", "notas/a.md");
    expect(found).toEqual(doc());
    expect(store.getDocumentBySource("pessoal", "missing")).toBeUndefined();
  });

  it("stats reports correct doc and chunk counts", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [chunk("c1", 0, "alpha content"), chunk("c2", 1, "beta content")],
      [vec(1), vec(2)],
    );
    expect(store.stats()).toEqual({ documents: 1, chunks: 2 });
    expect(vecCount(db!)).toBe(2);
    expect(ftsCount(db!, "alpha")).toBe(1);
  });

  it("replaceChunks fully swaps the chunk set", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [chunk("c1", 0, "alpha"), chunk("c2", 1, "beta")],
      [vec(1), vec(2)],
    );
    store.replaceChunks("doc-1", [chunk("c3", 0, "gamma")], [vec(3)]);

    expect(store.stats().chunks).toBe(1);
    expect(vecCount(db!)).toBe(1);
    expect(ftsCount(db!, "alpha")).toBe(0);
    expect(ftsCount(db!, "gamma")).toBe(1);
    const remaining = db!
      .prepare("SELECT chunk_id FROM chunks_vec")
      .all() as Array<{ chunk_id: string }>;
    expect(remaining.map((r) => r.chunk_id)).toEqual(["c3"]);
  });

  it("deleteDocument clears documents, chunks, chunks_fts and chunks_vec", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [chunk("c1", 0, "deletable text"), chunk("c2", 1, "more text")],
      [vec(1), vec(2)],
    );

    store.deleteDocument("doc-1");

    expect(store.stats()).toEqual({ documents: 0, chunks: 0 });
    expect(vecCount(db!)).toBe(0);
    expect(ftsCount(db!, "deletable")).toBe(0);
    expect(store.getDocumentBySource("pessoal", "notas/a.md")).toBeUndefined();
  });

  it("throws on chunk/embedding length mismatch", () => {
    const store = newStore();
    store.insertDocument(doc());
    expect(() =>
      store.replaceChunks("doc-1", [chunk("c1", 0, "x")], []),
    ).toThrow(/length mismatch/);
  });
});

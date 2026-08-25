import { describe, it, expect, afterEach } from "vitest";
import { openDb, loadVecExtension, migrate, type Db } from "../src/core/store.js";

let db: Db | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function open(): Db {
  const d = openDb(":memory:");
  loadVecExtension(d);
  migrate(d);
  return d;
}

function seedDoc(d: Db, id = "d1"): void {
  d.prepare(
    "INSERT INTO documents(id, collection, source, content_hash, mtime, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "pessoal", `${id}.md`, "h", 0, 0);
}

function tableNames(d: Db): Set<string> {
  const rows = d
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function triggerNames(d: Db): Set<string> {
  const rows = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("schema, migrations & triggers (B2)", () => {
  it("creates all tables and the three FTS sync triggers", () => {
    db = open();
    const tables = tableNames(db);
    for (const t of [
      "collections",
      "documents",
      "chunks",
      "chunks_fts",
      "chunks_vec",
      "embedding_cache",
    ]) {
      expect(tables.has(t)).toBe(true);
    }

    const triggers = triggerNames(db);
    expect(triggers.has("chunks_ai")).toBe(true);
    expect(triggers.has("chunks_ad")).toBe(true);
    expect(triggers.has("chunks_au")).toBe(true);
  });

  it("enables foreign keys and WAL", () => {
    db = open();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
  });

  it("inserting a chunk makes it findable via chunks_fts MATCH", () => {
    db = open();
    seedDoc(db);
    db.prepare(
      "INSERT INTO chunks(id, document_id, idx, text, token_estimate) VALUES (?, ?, ?, ?, ?)",
    ).run("c1", "d1", 0, "the quick brown fox jumps", 6);

    const row = db
      .prepare(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'brown' LIMIT 1",
      )
      .get() as { rowid: number } | undefined;
    expect(row).toBeDefined();
  });

  it("deleting a chunk removes it from FTS", () => {
    db = open();
    seedDoc(db);
    db.prepare(
      "INSERT INTO chunks(id, document_id, idx, text, token_estimate) VALUES (?, ?, ?, ?, ?)",
    ).run("c1", "d1", 0, "searchable content here", 3);
    db.prepare("DELETE FROM chunks WHERE id = ?").run("c1");

    const row = db
      .prepare(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'searchable' LIMIT 1",
      )
      .get();
    expect(row).toBeUndefined();
  });

  it("bumps user_version and re-running migration is a no-op", () => {
    db = open();
    expect(db.pragma("user_version", { simple: true })).toBe(1);

    seedDoc(db);
    db.prepare(
      "INSERT INTO chunks(id, document_id, idx, text, token_estimate) VALUES (?, ?, ?, ?, ?)",
    ).run("c1", "d1", 0, "persisted", 1);

    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    const count = db
      .prepare("SELECT count(*) AS n FROM chunks")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

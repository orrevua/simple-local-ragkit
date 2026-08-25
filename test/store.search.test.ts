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

function doc(): Document {
  return {
    id: "doc-1",
    collection: "pessoal",
    source: "notas/a.md",
    contentHash: "hash-1",
    metadata: {},
    mtime: 1000,
    createdAt: 2000,
  };
}

function chunk(id: string, idx: number, text: string): Chunk {
  return { id, documentId: "doc-1", idx, text, tokenEstimate: text.length };
}

/** Unit basis vector: 1 at `seed`, 0 elsewhere. Cosine distance from another
 * basis vector is 1 (orthogonal); distance from itself is 0. */
function vec(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === seed ? 1 : 0));
}

describe("SqliteStore.denseSearch (R1)", () => {
  it("returns k results ordered by ascending cosine distance with 1-based rank", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [
        chunk("c1", 0, "alpha"),
        chunk("c2", 1, "beta"),
        chunk("c3", 2, "gamma"),
      ],
      [vec(0), vec(1), vec(2)],
    );

    // A vector closest to vec(1), then partially toward vec(0).
    const query = vec(1).map((v, i) => (i === 0 ? 0.5 : v));
    const results = store.denseSearch(query, 2);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.chunkId)).toEqual(["c2", "c1"]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    expect(results[0]!.rawScore).toBeLessThan(results[1]!.rawScore);
    expect(results[0]!.chunk.text).toBe("beta");
  });
});

describe("SqliteStore.lexicalSearch (R1)", () => {
  it("exact function-name query returns the right chunk via the lexical leg", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [
        chunk("c1", 0, "utility helpers for formatting dates and numbers"),
        chunk("c2", 1, "function computeStats returns collection counts"),
        chunk("c3", 2, "generic notes about statistics and databases"),
      ],
      [vec(0), vec(1), vec(2)],
    );

    const results = store.lexicalSearch("computeStats", 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.chunkId).toBe("c2");
    expect(results[0]!.rank).toBe(1);
  });

  it("orders results by ascending bm25 (most negative first) and honors k", () => {
    const store = newStore();
    store.insertDocument(doc());
    store.replaceChunks(
      "doc-1",
      [
        chunk("c1", 0, "cache cache cache miss lookup"),
        chunk("c2", 1, "a single cache reference"),
        chunk("c3", 2, "unrelated content"),
      ],
      [vec(0), vec(1), vec(2)],
    );

    const results = store.lexicalSearch("cache", 5);

    expect(results.map((r) => r.chunkId)).toEqual(["c1", "c2"]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    expect(results[0]!.rawScore).toBeLessThanOrEqual(results[1]!.rawScore);
  });
});

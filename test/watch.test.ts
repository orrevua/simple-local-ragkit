import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagConfigSchema, type RagConfig } from "../src/config.js";
import { ingest } from "../src/core/ingest.js";
import {
  loadVecExtension,
  migrate,
  openDb,
  SqliteStore,
  type Db,
} from "../src/core/store.js";
import type { EmbeddingProvider } from "../src/core/types.js";
import {
  reindexFile,
  removeFile,
  type WatchContext,
  type WatchEvent,
} from "../src/core/watch.js";

let db: Db | undefined;
let tmp: string;

class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake-model";
  readonly dimensions = 768;
  texts = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.texts += texts.length;
    return texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      return Array.from({ length: 768 }, (_, i) => h[i % h.length]! / 255);
    });
  }
}

function newStore(): SqliteStore {
  db = openDb(":memory:");
  loadVecExtension(db);
  migrate(db);
  return new SqliteStore(db);
}

function config(roots: string[]): RagConfig {
  return RagConfigSchema.parse({ collection: "pessoal", roots });
}

function context(
  store: SqliteStore,
  embedder: FakeEmbedder,
  events: WatchEvent[],
): WatchContext {
  return {
    roots: [tmp],
    config: config([tmp]),
    store,
    embedder,
    collection: "pessoal",
    onEvent: (e) => events.push(e),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ragkit-watch-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

describe("watch handlers (P1)", () => {
  it("reindexes only the changed file", async () => {
    const aPath = path.join(tmp, "a.md");
    const bPath = path.join(tmp, "b.md");
    writeFileSync(aPath, "# A\nalpha body");
    writeFileSync(bPath, "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    await ingest({ store, embedder, config: config([tmp]) });
    expect(store.stats().documents).toBe(2);

    writeFileSync(aPath, "# A\nalpha body edited");
    embedder.texts = 0;

    const events: WatchEvent[] = [];
    await reindexFile(context(store, embedder, events), aPath);

    expect(embedder.texts).toBe(1);
    expect(store.stats().documents).toBe(2);
    expect(events).toContainEqual({
      type: "reindexed",
      source: "a.md",
      added: 0,
      updated: 1,
    });
    expect(store.getDocumentBySource("pessoal", "b.md")).toBeDefined();
  });

  it("indexes a newly added file", async () => {
    const store = newStore();
    const embedder = new FakeEmbedder();
    await ingest({ store, embedder, config: config([tmp]) });
    expect(store.stats().documents).toBe(0);

    const cPath = path.join(tmp, "c.md");
    writeFileSync(cPath, "# C\ngamma body");

    const events: WatchEvent[] = [];
    await reindexFile(context(store, embedder, events), cPath);

    expect(store.stats().documents).toBe(1);
    expect(events).toContainEqual({
      type: "reindexed",
      source: "c.md",
      added: 1,
      updated: 0,
    });
  });

  it("removes the document for an unlinked file", async () => {
    const aPath = path.join(tmp, "a.md");
    const bPath = path.join(tmp, "b.md");
    writeFileSync(aPath, "# A\nalpha body");
    writeFileSync(bPath, "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    await ingest({ store, embedder, config: config([tmp]) });
    expect(store.stats().documents).toBe(2);

    rmSync(aPath);
    const events: WatchEvent[] = [];
    removeFile(context(store, embedder, events), aPath);

    expect(store.stats().documents).toBe(1);
    expect(store.getDocumentBySource("pessoal", "a.md")).toBeUndefined();
    expect(store.getDocumentBySource("pessoal", "b.md")).toBeDefined();
    expect(events).toContainEqual({ type: "removed", source: "a.md" });
  });
});

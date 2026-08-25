import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDb,
  loadVecExtension,
  migrate,
  SqliteStore,
  type Db,
} from "../src/core/store.js";
import { RagConfigSchema, type RagConfig } from "../src/config.js";
import { ingest } from "../src/core/ingest.js";
import type { EmbeddingProvider } from "../src/core/types.js";

let db: Db | undefined;
let tmp: string;

class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake-model";
  readonly dimensions = 768;
  calls = 0;
  texts = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
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

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ragkit-ingest-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

describe("ingest (I5)", () => {
  it("adds all files on first run, unchanged on rerun", async () => {
    writeFileSync(path.join(tmp, "a.md"), "# A\nalpha body");
    mkdirSync(path.join(tmp, "sub"));
    writeFileSync(path.join(tmp, "sub", "b.md"), "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    const cfg = config([tmp]);

    const first = await ingest({ store, embedder, config: cfg });
    expect(first.added).toBe(2);
    expect(first.unchanged).toBe(0);
    expect(first.removed).toBe(0);
    expect(first.errors).toEqual([]);
    expect(store.stats().documents).toBe(2);
    expect(typeof first.ms).toBe("number");

    const second = await ingest({ store, embedder, config: cfg });
    expect(second.unchanged).toBe(2);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });

  it("re-embeds only the edited file", async () => {
    writeFileSync(path.join(tmp, "a.md"), "# A\nalpha body");
    writeFileSync(path.join(tmp, "b.md"), "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    const cfg = config([tmp]);

    await ingest({ store, embedder, config: cfg });
    const textsAfterFirst = embedder.texts;
    expect(textsAfterFirst).toBe(2);

    writeFileSync(path.join(tmp, "a.md"), "# A\nalpha body edited larger");

    embedder.calls = 0;
    embedder.texts = 0;
    const run = await ingest({ store, embedder, config: cfg });

    expect(run.updated).toBe(1);
    expect(run.unchanged).toBe(1);
    expect(embedder.texts).toBe(1);
  });

  it("removes documents whose source disappeared from disk", async () => {
    const aPath = path.join(tmp, "a.md");
    writeFileSync(aPath, "# A\nalpha body");
    writeFileSync(path.join(tmp, "b.md"), "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    const cfg = config([tmp]);

    await ingest({ store, embedder, config: cfg });
    expect(store.stats().documents).toBe(2);

    rmSync(aPath);
    const run = await ingest({ store, embedder, config: cfg });

    expect(run.removed).toBe(1);
    expect(run.unchanged).toBe(1);
    expect(store.stats().documents).toBe(1);
    expect(
      store.getDocumentBySource("pessoal", "a.md"),
    ).toBeUndefined();
  });

  it("scopes removal to the ingested path (I6 fix)", async () => {
    const dirA = path.join(tmp, "A");
    const dirB = path.join(tmp, "B");
    mkdirSync(dirA);
    mkdirSync(dirB);
    writeFileSync(path.join(dirA, "a.md"), "# A\nalpha body");
    writeFileSync(path.join(dirB, "b.md"), "# B\nbeta body");

    const store = newStore();
    const embedder = new FakeEmbedder();
    const cfg = config([dirA, dirB]);

    await ingest({ store, embedder, config: cfg });
    expect(store.stats().documents).toBe(2);

    // Re-ingest only root A. B's document must NOT be flagged as removed.
    const run = await ingest({
      store,
      embedder,
      config: cfg,
      paths: [dirA],
    });

    expect(run.removed).toBe(0);
    expect(run.unchanged).toBe(1);
    expect(store.stats().documents).toBe(2);
    expect(store.getDocumentBySource("pessoal", "b.md")).toBeDefined();
  });
});

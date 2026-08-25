import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDb,
  loadVecExtension,
  migrate,
  type Db,
} from "../src/core/store.js";
import { OllamaEmbeddings } from "../src/core/embedder.js";
import {
  ModelNotFoundError,
  OllamaUnavailableError,
} from "../src/core/errors.js";

let db: Db | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  db?.close();
  db = undefined;
});

function newDb(): Db {
  db = openDb(":memory:");
  loadVecExtension(db);
  migrate(db);
  return db;
}

function vec(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i + seed) % 7);
}

function okResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OllamaEmbeddings (I4)", () => {
  it("embeds only cache misses, writes cache, preserves order", async () => {
    const database = newDb();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return okResponse(body.input.map((_, i) => vec(i)));
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbeddings(database);

    const first = await embedder.embed(["a", "b"]);
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(vec(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cachedRows = database
      .prepare("SELECT count(*) AS n FROM embedding_cache")
      .get() as { n: number };
    expect(cachedRows.n).toBe(2);

    fetchMock.mockClear();
    const second = await embedder.embed(["b", "c", "a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      String(fetchMock.mock.calls[0]![1]?.body),
    ) as { input: string[] };
    expect(sent.input).toEqual(["c"]);
    expect(second[0]).toEqual(first[1]);
    expect(second[2]).toEqual(first[0]);
  });

  it("maps connection refused to OllamaUnavailableError", async () => {
    const database = newDb();
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw refused;
      }),
    );

    const embedder = new OllamaEmbeddings(database);
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    );
  });

  it("maps a model-404 to ModelNotFoundError", async () => {
    const database = newDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"error":"model \\"nomic-embed-text\\" not found"}', {
            status: 404,
          }),
      ),
    );

    const embedder = new OllamaEmbeddings(database);
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(
      ModelNotFoundError,
    );
  });

  it("validates dimensions", async () => {
    const database = newDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse([[1, 2, 3]])),
    );
    const embedder = new OllamaEmbeddings(database);
    await expect(embedder.embed(["x"])).rejects.toThrow(/expected 768/);
  });
});

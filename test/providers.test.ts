import { afterEach, describe, expect, it, vi } from "vitest";
import { RagConfigSchema } from "../src/config.js";
import { OllamaEmbeddings } from "../src/core/embedder.js";
import {
  createEmbedder,
  EmbeddingProviderError,
  hashEmbed,
  HashEmbeddings,
  OpenAICompatibleEmbeddings,
} from "../src/core/providers.js";
import { loadVecExtension, migrate, openDb, type Db } from "../src/core/store.js";

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

function cosine(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i]!, 0);
}

function memoryCache() {
  const map = new Map<string, number[]>();
  return {
    get: (h: string, m: string) => map.get(`${m}:${h}`),
    set: (h: string, m: string, e: number[]) => void map.set(`${m}:${h}`, e),
  };
}

describe("HashEmbeddings", () => {
  it("is deterministic, 768-d and unit length", async () => {
    const [a, b] = await new HashEmbeddings().embed(["hello world", "hello world"]);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b);
    expect(cosine(a!, a!)).toBeCloseTo(1, 6);
  });

  it("gives lexically similar texts a higher cosine", () => {
    const q = hashEmbed("configure cors middleware", 768);
    const near = hashEmbed("how to configure the cors middleware", 768);
    const far = hashEmbed("upload files with forms", 768);
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });
});

describe("OpenAICompatibleEmbeddings", () => {
  it("posts model, input and dimensions, sorts by index and caches", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: "m", dimensions: 768 });
      const data = (body.input as string[]).map((_, index) => ({
        index,
        embedding: new Array(768).fill(index),
      }));
      return new Response(JSON.stringify({ data: data.reverse() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const e = new OpenAICompatibleEmbeddings(memoryCache(), {
      model: "m",
      baseUrl: "http://x/v1/",
      apiKey: "k",
    });

    const out = await e.embed(["a", "b"]);
    await e.embed(["a", "b"]);

    expect(out[0]![0]).toBe(0);
    expect(out[1]![0]).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("explains a dimension mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] })),
      ),
    );
    const e = new OpenAICompatibleEmbeddings(memoryCache(), { model: "m" });
    await expect(e.embed(["a"])).rejects.toThrow(EmbeddingProviderError);
  });
});

describe("createEmbedder", () => {
  it("builds the provider named in config", () => {
    const d = newDb();
    const cfg = (provider: string) =>
      RagConfigSchema.parse({ embeddings: { provider } });
    expect(createEmbedder(cfg("hash"), d)).toBeInstanceOf(HashEmbeddings);
    expect(createEmbedder(cfg("openai"), d)).toBeInstanceOf(OpenAICompatibleEmbeddings);
    expect(createEmbedder(cfg("ollama"), d)).toBeInstanceOf(OllamaEmbeddings);
  });
});

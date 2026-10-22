import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RagConfigSchema } from "../src/config.js";
import { createHttpServer } from "../src/http/server.js";
import type {
  Chunk,
  Document,
  HybridSearchOptions,
  HybridSearchResult,
  Retriever,
  Store,
} from "../src/core/types.js";

const chunk: Chunk = {
  id: "c1",
  documentId: "d1",
  idx: 0,
  text: "configure CORS with CORSMiddleware",
  headingPath: "CORS",
  startLine: 1,
  endLine: 3,
  tokenEstimate: 6,
  source: "cors.md",
};

const doc: Document = {
  id: "d1",
  collection: "c",
  source: "cors.md",
  contentHash: "h",
  metadata: { ext: ".md" },
  mtime: 0,
  createdAt: 0,
};

class FakeRetriever implements Retriever {
  calls: Array<{ query: string; options?: HybridSearchOptions }> = [];
  async hybridSearch(query: string, options?: HybridSearchOptions): Promise<HybridSearchResult> {
    this.calls.push({ query, options });
    return {
      results: [{ chunkId: "c1", rank: 1, score: 0.03, normalizedScore: 1, chunk }],
      explain: {
        query,
        strategy: options?.strategy ?? "hybrid",
        topK: 8,
        rrfK: 60,
        minScore: 0,
        dense: [],
        lexical: [],
        fused: [],
        maxFusedScore: 0.03,
      },
    };
  }
}

const store = {
  listCollections: () => [{ name: "c", documents: 1, chunks: 1 }],
  getDocumentBySource: (_c: string, source: string) =>
    source === "cors.md" ? doc : undefined,
  getDocumentChunks: () => [chunk],
} as unknown as Store;

let server: Server | undefined;

afterEach(async () => {
  await new Promise((r) => server?.close(r));
  server = undefined;
});

async function start(token?: string) {
  const retriever = new FakeRetriever();
  server = createHttpServer({
    store,
    retriever,
    config: RagConfigSchema.parse({}),
    collection: "c",
    token,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, retriever };
}

describe("HTTP API", () => {
  it("searches with strategy and returns cited context", async () => {
    const { base, retriever } = await start();
    const res = await fetch(`${base}/search`, {
      method: "POST",
      body: JSON.stringify({ query: "cors?", topK: 3, strategy: "lexical" }),
    });
    const body = (await res.json()) as {
      strategy: string;
      results: Array<Record<string, unknown>>;
      context: string;
    };

    expect(res.status).toBe(200);
    expect(body.strategy).toBe("lexical");
    expect(body.results[0]).toMatchObject({ source: "cors.md", headingPath: "CORS" });
    expect(body.context).toContain("CORSMiddleware");
    expect(retriever.calls[0]!.options).toMatchObject({ topK: 3, strategy: "lexical" });
  });

  it("validates the body and unknown routes", async () => {
    const { base } = await start();
    const bad = await fetch(`${base}/search`, {
      method: "POST",
      body: JSON.stringify({ query: "", strategy: "magic" }),
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/documents?source=x.md`)).status).toBe(404);
    const ok = await fetch(`${base}/documents?source=cors.md`);
    expect(((await ok.json()) as { chunks: unknown[] }).chunks).toHaveLength(1);
  });

  it("requires the bearer token except on /health", async () => {
    const { base } = await start("s3cret");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/collections`)).status).toBe(401);
    const ok = await fetch(`${base}/collections`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(ok.status).toBe(200);
  });
});

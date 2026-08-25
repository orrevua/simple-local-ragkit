import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerTools } from "../src/mcp/tools.js";
import { RagConfigSchema, type RagConfig } from "../src/config.js";
import type {
  Chunk,
  CollectionSummary,
  Document,
  HybridSearchOptions,
  HybridSearchResult,
  RankedResult,
  Retriever,
  SearchResult,
  Store,
  StoreStats,
} from "../src/core/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

/** Minimal McpServer stand-in that captures registered tool handlers. */
class CaptureServer {
  readonly handlers = new Map<string, Handler>();
  registerTool(name: string, _config: unknown, cb: Handler): void {
    this.handlers.set(name, cb);
  }
}

function chunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "c1",
    documentId: "d1",
    idx: 0,
    text: "hello world",
    tokenEstimate: 5,
    source: "notes/a.md",
    ...overrides,
  };
}

function ranked(chunk: Chunk): RankedResult {
  return { chunkId: chunk.id, rank: 1, score: 0.02, normalizedScore: 1, chunk };
}

class FakeRetriever implements Retriever {
  constructor(private readonly results: RankedResult[]) {}
  async hybridSearch(
    query: string,
    _options?: HybridSearchOptions,
  ): Promise<HybridSearchResult> {
    return {
      results: this.results,
      explain: {
        query,
        topK: 8,
        rrfK: 60,
        minScore: 0,
        dense: [],
        lexical: [],
        fused: [],
        maxFusedScore: 0,
      },
    };
  }
}

class ThrowingRetriever implements Retriever {
  async hybridSearch(): Promise<HybridSearchResult> {
    throw new Error("boom");
  }
}

type StoreState = {
  collections?: CollectionSummary[];
  doc?: Document;
  chunks?: Chunk[];
};

class FakeStore implements Store {
  constructor(private readonly state: StoreState = {}) {}
  upsertCollection(): void {}
  getDocumentBySource(): Document | undefined {
    return this.state.doc;
  }
  insertDocument(): void {}
  deleteDocument(): void {}
  replaceChunks(): void {}
  denseSearch(): SearchResult[] {
    return [];
  }
  lexicalSearch(): SearchResult[] {
    return [];
  }
  stats(): StoreStats {
    return { documents: 0, chunks: 0 };
  }
  listCollections(): CollectionSummary[] {
    return this.state.collections ?? [];
  }
  getDocumentChunks(): Chunk[] {
    return this.state.chunks ?? [];
  }
}

function config(roots: string[] = []): RagConfig {
  return { ...RagConfigSchema.parse({}), roots };
}

function register(
  store: Store,
  retriever: Retriever,
  cfg: RagConfig = config(),
): Map<string, Handler> {
  const server = new CaptureServer();
  registerTools(server as never, {
    store,
    retriever,
    config: cfg,
    collection: cfg.collection,
  });
  return server.handlers;
}

describe("MCP tools registration", () => {
  it("registers exactly three tools", () => {
    const handlers = register(new FakeStore(), new FakeRetriever([]));
    expect([...handlers.keys()].sort()).toEqual([
      "get_document",
      "list_collections",
      "search_context",
    ]);
  });
});

describe("search_context tool", () => {
  it("returns cited chunks with source and score", async () => {
    const c = chunk({ headingPath: "Notes", startLine: 3, endLine: 8 });
    const handlers = register(new FakeStore(), new FakeRetriever([ranked(c)]));
    const res = await handlers.get("search_context")!({ query: "hello" });

    expect(res.isError).toBeFalsy();
    const out = res.content[0]!.text;
    expect(out).toContain("<context>");
    expect(out).toContain("notes/a.md");
    expect(out).toContain("Sources:");
    expect(out).toContain("[1]");
  });

  it("reports no matches without erroring", async () => {
    const handlers = register(new FakeStore(), new FakeRetriever([]));
    const res = await handlers.get("search_context")!({ query: "nothing" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("No matching context");
  });

  it("turns retriever failures into readable error strings", async () => {
    const handlers = register(new FakeStore(), new ThrowingRetriever());
    const res = await handlers.get("search_context")!({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("search_context failed: boom");
    expect(res.content[0]!.text).not.toContain("at ");
  });
});

describe("list_collections tool", () => {
  it("lists collections with counts", async () => {
    const store = new FakeStore({
      collections: [{ name: "pessoal", documents: 2, chunks: 9 }],
    });
    const handlers = register(store, new FakeRetriever([]));
    const res = await handlers.get("list_collections")!({});
    expect(res.content[0]!.text).toBe("pessoal: 2 documents, 9 chunks");
  });

  it("handles an empty base", async () => {
    const handlers = register(new FakeStore(), new FakeRetriever([]));
    const res = await handlers.get("list_collections")!({});
    expect(res.content[0]!.text).toContain("No collections");
  });
});

describe("get_document tool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ragkit-mcp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function doc(): Document {
    return {
      id: "d1",
      collection: "pessoal",
      source: "notes/a.md",
      contentHash: "h",
      metadata: {},
      mtime: 0,
      createdAt: 0,
    };
  }

  it("returns full file content when the source exists on disk", async () => {
    const filePath = path.join(dir, "notes", "a.md");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "FULL FILE BODY");

    const store = new FakeStore({ doc: doc() });
    const handlers = register(store, new FakeRetriever([]), config([dir]));
    const res = await handlers.get("get_document")!({ source: "notes/a.md" });
    expect(res.content[0]!.text).toBe("FULL FILE BODY");
  });

  it("falls back to reassembled chunks when the file is gone", async () => {
    const store = new FakeStore({
      doc: doc(),
      chunks: [
        chunk({ id: "c1", idx: 0, text: "part one" }),
        chunk({ id: "c2", idx: 1, text: "part two" }),
      ],
    });
    const handlers = register(store, new FakeRetriever([]), config([dir]));
    const res = await handlers.get("get_document")!({ source: "notes/a.md" });
    expect(res.content[0]!.text).toBe("part one\n\npart two");
  });

  it("returns a readable not-found message", async () => {
    const handlers = register(new FakeStore(), new FakeRetriever([]));
    const res = await handlers.get("get_document")!({ source: "missing.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe("document not found: missing.md");
  });
});

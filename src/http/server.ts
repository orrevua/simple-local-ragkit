import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RagConfig } from "../config.js";
import { buildContext } from "../core/context.js";
import { RETRIEVAL_STRATEGIES } from "../core/retriever.js";
import type {
  MetadataFilter,
  RetrievalStrategy,
  Retriever,
  Store,
} from "../core/types.js";

export type HttpDeps = {
  store: Store;
  retriever: Retriever;
  config: RagConfig;
  collection: string;
  /** When set, every route except /health requires `Authorization: Bearer <token>`. */
  token?: string;
};

const MAX_BODY_BYTES = 64 * 1024;

const SearchBody = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  strategy: z
    .enum(Object.keys(RETRIEVAL_STRATEGIES) as [RetrievalStrategy, ...RetrievalStrategy[]])
    .optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    parts.push(part as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body must be valid JSON.");
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A small JSON API over the same retriever the CLI and MCP server use, so
 * non-MCP clients (a web app, a Python agent, curl) can query the knowledge
 * base. Plain `node:http` on purpose: four routes don't need a framework.
 *
 *   GET  /health                  liveness, never authenticated
 *   GET  /collections             collections with counts
 *   POST /search                  { query, topK?, strategy?, filter? }
 *   GET  /documents?source=a.md   chunks of one indexed document
 */
export function createHttpHandler(deps: HttpDeps) {
  const { store, retriever, config, collection, token } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, collection });
      }
      if (token && !authorized(req, token)) {
        throw new HttpError(401, "Missing or invalid bearer token.");
      }

      if (req.method === "GET" && url.pathname === "/collections") {
        return send(res, 200, { collections: store.listCollections() });
      }

      if (req.method === "POST" && url.pathname === "/search") {
        const parsed = SearchBody.safeParse(await readJson(req));
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
            .join("; ");
          throw new HttpError(400, issues);
        }
        const { query, topK, strategy, filter } = parsed.data;
        const search = await retriever.hybridSearch(query, {
          topK,
          strategy,
          filter: filter as MetadataFilter | undefined,
        });
        const context = buildContext(search.results, config.retrieval.contextTokens);
        return send(res, 200, {
          query,
          strategy: search.explain.strategy,
          results: search.results.map((r) => ({
            rank: r.rank,
            score: r.normalizedScore,
            source: r.chunk.source,
            headingPath: r.chunk.headingPath ?? null,
            startLine: r.chunk.startLine ?? null,
            endLine: r.chunk.endLine ?? null,
            text: r.chunk.text,
          })),
          context: context.text,
          sources: context.sources,
        });
      }

      if (req.method === "GET" && url.pathname === "/documents") {
        const source = url.searchParams.get("source");
        if (!source) throw new HttpError(400, "Query parameter `source` is required.");
        const doc = store.getDocumentBySource(collection, source);
        if (!doc) throw new HttpError(404, `Document not found: ${source}`);
        const chunks = store.getDocumentChunks(doc.id);
        return send(res, 200, { source, metadata: doc.metadata, chunks });
      }

      throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      return send(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function createHttpServer(deps: HttpDeps): Server {
  const handler = createHttpHandler(deps);
  return createServer((req, res) => void handler(req, res));
}

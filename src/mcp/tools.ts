import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContext } from "../core/context.js";
import { resolveRoots } from "../core/loaders.js";
import type { McpDeps } from "./server.js";
import type { MetadataFilter } from "../core/types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function errorText(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SEARCH_CONTEXT_DESCRIPTION =
  "Search the user's locally-indexed personal knowledge base — their docs, " +
  "notes, specs, and code repositories that are NOT open in the current " +
  "workspace — and return the most relevant passages with citations. Call " +
  "this BEFORE answering any question that references the user's prior work, " +
  "past decisions, earlier projects, or documentation you cannot see in the " +
  "current session. Prefer it over guessing whenever the question mentions " +
  "something the user has evidently written down or built before.";

/**
 * Resolve a stored root-relative `source` to an absolute path under one of the
 * configured roots, preferring a root where the file actually exists so that
 * identical basenames across roots disambiguate. Returns undefined when the
 * source escapes every root.
 */
function resolveSourceAbs(source: string, roots: string[]): string | undefined {
  const candidates = roots
    .map((root) => path.resolve(root, source))
    .filter((abs, i) => {
      const rel = path.relative(roots[i]!, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  if (candidates.length === 0) return undefined;
  return candidates.find(existsSync) ?? candidates[0];
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const { store, retriever, config, collection } = deps;
  const roots = resolveRoots(config.roots);

  server.registerTool(
    "search_context",
    {
      description: SEARCH_CONTEXT_DESCRIPTION,
      inputSchema: {
        query: z.string().describe("Natural-language or exact-term query."),
        topK: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max number of passages to return."),
        filter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Metadata equality/$in filter, e.g. { ext: \"ts\" }."),
      },
    },
    async ({ query, topK, filter }) => {
      try {
        const { results } = await retriever.hybridSearch(query, {
          topK,
          filter: filter as MetadataFilter | undefined,
        });
        if (results.length === 0) {
          return text(`No matching context found for: ${query}`);
        }
        const built = buildContext(results, config.retrieval.contextTokens);
        const cited = built.sources
          .map((s) => {
            const loc = s.lines ? `:${s.lines}` : "";
            const heading = s.headingPath ? ` — ${s.headingPath}` : "";
            return `[${s.n}] ${s.source}${loc}${heading} (score ${s.score.toFixed(3)})`;
          })
          .join("\n");
        return text(`${built.text}\n\nSources:\n${cited}`);
      } catch (err) {
        return errorText(`search_context failed: ${messageOf(err)}`);
      }
    },
  );

  server.registerTool(
    "list_collections",
    {
      description:
        "List the user's indexed collections with their document and chunk " +
        "counts. Use to discover what knowledge bases are available.",
      inputSchema: {},
    },
    async () => {
      try {
        const collections = store.listCollections();
        if (collections.length === 0) {
          return text("No collections have been indexed yet.");
        }
        const lines = collections.map(
          (c) => `${c.name}: ${c.documents} documents, ${c.chunks} chunks`,
        );
        return text(lines.join("\n"));
      } catch (err) {
        return errorText(`list_collections failed: ${messageOf(err)}`);
      }
    },
  );

  server.registerTool(
    "get_document",
    {
      description:
        "Fetch the full content of a single indexed document by its stored " +
        "source path (root-relative, forward slashes). Use after " +
        "search_context to read a cited source in full.",
      inputSchema: {
        source: z
          .string()
          .describe("Root-relative source path, e.g. docs/setup.md."),
      },
    },
    async ({ source }) => {
      try {
        const doc = store.getDocumentBySource(collection, source);
        if (!doc) {
          return text(`document not found: ${source}`);
        }

        const abs = resolveSourceAbs(source, roots);
        if (abs) {
          try {
            return text(readFileSync(abs, "utf8"));
          } catch {
            // file gone from disk — fall back to reassembling from chunks
          }
        }

        // Fallback: reassemble from stored chunks ordered by idx. Chunk overlap
        // (size/overlap chunking) means the reassembled text may repeat spans
        // at boundaries; this is best-effort when the source file is gone.
        const chunks = store.getDocumentChunks(doc.id);
        if (chunks.length === 0) {
          return text(`document has no stored content: ${source}`);
        }
        return text(chunks.map((c) => c.text).join("\n\n"));
      } catch (err) {
        return errorText(`get_document failed: ${messageOf(err)}`);
      }
    },
  );
}

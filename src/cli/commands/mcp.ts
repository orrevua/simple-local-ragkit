import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../../config.js";
import { OllamaEmbeddings } from "../../core/embedder.js";
import { RagError } from "../../core/errors.js";
import * as log from "../../core/logger.js";
import { HybridRetriever } from "../../core/retriever.js";
import { createServer } from "../../mcp/server.js";
import { openStore } from "./ingest.js";

export type McpCommandOptions = {
  collection?: string;
};

/**
 * Launch the MCP stdio server. Stdout is reserved exclusively for MCP protocol
 * frames (R9): every diagnostic goes through the stderr logger, and startup
 * failures print a legible, actionable message to stderr before exiting
 * non-zero — never a stack trace, never anything on stdout. The store stays
 * open for the lifetime of the long-lived stdio process.
 */
export async function runMcp(
  cwd: string,
  options: McpCommandOptions,
): Promise<void> {
  const config = await loadConfig(cwd).catch((err) => {
    fail("Could not load ragkit config", err);
  });
  const collection = options.collection ?? config.collection;

  const { db, store } = (() => {
    try {
      return openStore(config.dbPath);
    } catch (err) {
      fail("Could not open the collection database", err);
    }
  })();

  try {
    const embedder = new OllamaEmbeddings(db, {
      model: config.embeddings.model,
      baseUrl: config.embeddings.baseUrl,
    });
    const retriever = new HybridRetriever({ store, embedder, config });
    const server = createServer({ store, retriever, config, collection });
    await server.connect(new StdioServerTransport());
    log.info(`ragkit MCP server ready (collection "${collection}")`);
  } catch (err) {
    db.close();
    fail("Could not start the MCP server", err);
  }
}

function fail(context: string, err: unknown): never {
  const detail =
    err instanceof RagError || err instanceof Error
      ? err.message
      : String(err);
  log.error(`${context}: ${detail}`);
  process.exit(1);
}

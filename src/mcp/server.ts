import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RagConfig } from "../config.js";
import type { Retriever, Store } from "../core/types.js";
import { registerTools } from "./tools.js";

export type McpDeps = {
  store: Store;
  retriever: Retriever;
  config: RagConfig;
  collection: string;
};

/**
 * Build the ragkit MCP server. Diagnostics never touch stdout — that stream is
 * owned exclusively by the stdio transport for protocol frames (R9); use the
 * stderr logger for anything human-facing.
 */
export function createServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "ragkit", version: "0.1.0" });
  registerTools(server, deps);
  return server;
}

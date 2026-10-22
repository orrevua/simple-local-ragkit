import { loadConfig } from "../../config.js";
import * as log from "../../core/logger.js";
import { createEmbedder } from "../../core/providers.js";
import { HybridRetriever } from "../../core/retriever.js";
import { createHttpServer } from "../../http/server.js";
import { openStore } from "./ingest.js";

export type ServeCommandOptions = {
  collection?: string;
  host?: string;
  port?: number;
};

/**
 * Serve the collection over HTTP. Binds to 127.0.0.1 by default; set
 * RAGKIT_API_TOKEN before exposing it on any other interface.
 */
export async function runServe(
  cwd: string,
  options: ServeCommandOptions,
): Promise<void> {
  const config = await loadConfig(cwd);
  const collection = options.collection ?? config.collection;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const token = process.env.RAGKIT_API_TOKEN;

  if (host !== "127.0.0.1" && host !== "localhost" && !token) {
    log.warn(
      `Serving on ${host} without RAGKIT_API_TOKEN: anyone who can reach this ` +
        "port can read your knowledge base.",
    );
  }

  const { db, store } = openStore(config.dbPath);
  const embedder = createEmbedder(config, db);
  const retriever = new HybridRetriever({ store, embedder, config });
  const server = createHttpServer({ store, retriever, config, collection, token });

  const shutdown = (): void => {
    server.close(() => db.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  log.success(
    `ragkit HTTP API on http://${host}:${port} (collection "${collection}"` +
      `${token ? ", bearer auth on" : ""})`,
  );
}

#!/usr/bin/env node
import { Command } from "commander";
import { RagError } from "../core/errors.js";
import * as log from "../core/logger.js";
import { runIngest } from "./commands/ingest.js";
import { runInit } from "./commands/init.js";
import { runQuery } from "./commands/query.js";
import { runStats } from "./commands/stats.js";
import { runDoctor } from "./commands/doctor.js";
import { runMcp } from "./commands/mcp.js";

type GlobalOptions = {
  collection?: string;
  verbose?: boolean;
};

function fail(err: unknown): never {
  if (err instanceof RagError) {
    log.error(err.message);
  } else if (err instanceof Error) {
    log.error(err.message);
  } else {
    log.error(String(err));
  }
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ragkit")
    .description("Local-first hybrid-RAG CLI over SQLite + Ollama.")
    .option("-c, --collection <name>", "collection to operate on")
    .option("-v, --verbose", "verbose logging to stderr", false)
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.opts<GlobalOptions>();
      log.setVerbose(Boolean(opts.verbose));
    });

  const globals = (cmd: Command): GlobalOptions =>
    cmd.optsWithGlobals<GlobalOptions>();

  program
    .command("init")
    .description("Create a ragkit.config.ts and collection database.")
    .option("-f, --force", "overwrite the config and recreate the collection", false)
    .action(async (opts: { force?: boolean }) => {
      try {
        await runInit(process.cwd(), { force: opts.force });
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("ingest")
    .description("Index files into the collection.")
    .argument("[path]", "file, folder, or glob to ingest (defaults to config roots)")
    .option("-w, --watch", "watch roots and reindex changed files", false)
    .action(
      async (
        path: string | undefined,
        opts: { watch?: boolean },
        cmd: Command,
      ) => {
        const g = globals(cmd);
        try {
          await runIngest(process.cwd(), path, {
            collection: g.collection,
            watch: opts.watch,
          });
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("query")
    .description("Run a hybrid retrieval query and print the context block.")
    .argument("<query>", "natural-language or exact-term query")
    .option("--top-k <n>", "number of results to return", (v) => parseInt(v, 10))
    .option("--explain", "print both legs, RRF math, and budget decisions", false)
    .option("--json", "print a single JSON object to stdout", false)
    .action(
      async (
        query: string,
        opts: { topK?: number; explain?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const g = globals(cmd);
        try {
          await runQuery(process.cwd(), query, {
            collection: g.collection,
            topK: opts.topK,
            explain: opts.explain,
            json: opts.json,
          });
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("stats")
    .description("Report collection size and last ingestion.")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      try {
        await runStats(process.cwd(), { collection: g.collection });
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("doctor")
    .description("Validate Ollama, embed model, and database health.")
    .action(async (_opts, cmd: Command) => {
      globals(cmd);
      try {
        process.exitCode = await runDoctor(process.cwd());
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("mcp")
    .description("Run the MCP stdio server over the collection.")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      try {
        await runMcp(process.cwd(), { collection: g.collection });
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch(fail);

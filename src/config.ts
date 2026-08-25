import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { createJiti } from "jiti";
import { z } from "zod";

export const RagConfigSchema = z.object({
  collection: z.string().default("pessoal"),
  dbPath: z.string().default("~/.ragkit/pessoal.db"),
  roots: z.array(z.string()).default([]),
  embeddings: z
    .object({
      provider: z.string().default("ollama"),
      model: z.string().default("nomic-embed-text"),
      baseUrl: z.string().optional(),
    })
    .default({}),
  chunking: z
    .object({
      size: z.number().int().positive().default(800),
      overlap: z.number().int().nonnegative().default(120),
    })
    .default({}),
  retrieval: z
    .object({
      topK: z.number().int().positive().default(8),
      minScore: z.number().default(0.3),
      contextTokens: z.number().int().positive().default(4000),
      rrfK: z.number().int().positive().default(60),
    })
    .default({}),
  ignore: z.array(z.string()).default([]),
});

export type RagConfig = z.infer<typeof RagConfigSchema>;
export type RagConfigInput = z.input<typeof RagConfigSchema>;

export function defineConfig(config: RagConfigInput): RagConfigInput {
  return config;
}

const CONFIG_FILENAMES = [
  "ragkit.config.ts",
  "ragkit.config.js",
  "ragkit.config.mjs",
] as const;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

function normalizePath(p: string): string {
  return toPosix(expandHome(p));
}

function normalizeConfigPaths(config: RagConfig): RagConfig {
  return {
    ...config,
    dbPath: normalizePath(config.dbPath),
    roots: config.roots.map(normalizePath),
    ignore: config.ignore.map(toPosix),
  };
}

function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const homeDir = path.join(os.homedir(), ".ragkit");
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(homeDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function loadConfig(cwd: string): Promise<RagConfig> {
  const found = findConfigFile(cwd);

  if (!found) {
    const names = CONFIG_FILENAMES.join(", ");
    throw new Error(
      `No ragkit config found. Searched ${cwd} and its parents, plus ${path.join(os.homedir(), ".ragkit")} (looked for: ${names}).`,
    );
  }

  const jiti = createJiti(found);
  let loaded: unknown;
  try {
    loaded = await jiti.import(found, { default: true });
  } catch (cause) {
    throw new Error(`Failed to load config ${found}: ${String(cause)}`, {
      cause,
    });
  }

  const parsed = RagConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ragkit config at ${found}:\n${issues}`);
  }

  return normalizeConfigPaths(parsed.data);
}

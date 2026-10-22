import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, RagConfigSchema, type RagConfig } from "../../config.js";
import { chunkFile, type ChunkDraft } from "../../core/chunker.js";

export type ChunksCommandOptions = {
  size?: number;
  overlap?: number;
  full?: boolean;
};

function preview(text: string, full: boolean): string {
  if (full) return text;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

/**
 * Learning mode for chunking: show exactly where a file would be split,
 * without touching the database. Change --size/--overlap and watch the
 * boundaries move. That is the fastest way to build intuition for why
 * chunking dominates retrieval quality.
 */
export function formatChunks(
  file: string,
  drafts: ChunkDraft[],
  opts: { size: number; overlap: number; full?: boolean },
): string {
  const out = [
    `${file}: ${drafts.length} chunks (size=${opts.size} overlap=${opts.overlap} tokens)`,
    "",
  ];
  for (const d of drafts) {
    const lines =
      d.startLine !== undefined ? `  lines ${d.startLine}-${d.endLine}` : "";
    out.push(`#${d.idx}${lines}  ~${d.tokenEstimate} tokens`);
    if (d.headingPath) out.push(`    heading: ${d.headingPath}`);
    out.push(`    ${preview(d.text, Boolean(opts.full)).split("\n").join("\n    ")}`);
    out.push("");
  }
  const sizes = drafts.map((d) => d.tokenEstimate);
  if (sizes.length > 0) {
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    out.push(
      `token estimate per chunk: min ${Math.min(...sizes)}, ` +
        `avg ${avg.toFixed(0)}, max ${Math.max(...sizes)}`,
    );
  }
  return out.join("\n");
}

export async function runChunks(
  cwd: string,
  file: string,
  options: ChunksCommandOptions,
): Promise<void> {
  // A config is optional here: the command is useful before `ragkit init`.
  const config: RagConfig = await loadConfig(cwd).catch(() =>
    RagConfigSchema.parse({}),
  );
  const size = options.size ?? config.chunking.size;
  const overlap = options.overlap ?? config.chunking.overlap;
  const content = readFileSync(path.resolve(cwd, file), "utf8");
  const drafts = chunkFile({ ext: path.extname(file), content }, { size, overlap });
  process.stdout.write(
    `${formatChunks(file, drafts, { size, overlap, full: options.full })}\n`,
  );
}

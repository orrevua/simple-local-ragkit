import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { globbySync } from "globby";
import type { RagConfig } from "../config.js";

export type RawFile = {
  source: string;
  absPath: string;
  ext: string;
  dir: string;
  mtime: number;
  content: string;
  contentHash: string;
  metadata: {
    ext: string;
    relPath: string;
    dir: string;
    mtime: number;
  };
};

export const SUPPORTED_EXTS = [
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".py",
  ".sql",
  ".json",
  ".yaml",
] as const;

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
];

const MAX_FILE_BYTES = 1024 * 1024;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

type ResolvedInput = {
  root: string;
  patterns: string[];
};

function resolveInput(input: string): ResolvedInput {
  const abs = path.resolve(input);
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(abs);
  } catch {
    stat = undefined;
  }

  if (stat?.isDirectory()) {
    return { root: abs, patterns: ["**/*"] };
  }
  if (stat?.isFile()) {
    return { root: path.dirname(abs), patterns: [path.basename(abs)] };
  }

  const posix = toPosix(abs);
  const magicIdx = posix.search(/[*?{[]/);
  const slash = magicIdx === -1 ? -1 : posix.lastIndexOf("/", magicIdx);
  const root = slash === -1 ? process.cwd() : posix.slice(0, slash);
  const pattern = slash === -1 ? posix : posix.slice(slash + 1);
  return { root, patterns: [pattern] };
}

/**
 * Resolve the set of absolute root directories the given inputs ingest under.
 * `source` values are stored relative to these roots, so removal scoping can
 * test whether a stored document falls within an ingested root.
 */
export function resolveRoots(inputs: string[]): string[] {
  const roots = new Set<string>();
  for (const input of inputs) {
    roots.add(path.resolve(resolveInput(input).root));
  }
  return [...roots];
}

/**
 * Load supported files from folders, single files, or globs.
 * Honors `.gitignore`, `.ragkitignore`, and config `ignore` patterns; skips
 * default noise dirs, files > 1 MB, and binaries. Each file's `source` is
 * root-relative with forward slashes for stable cross-run identity.
 */
export function loadFiles(inputs: string[], config: RagConfig): RawFile[] {
  const ignore = [...DEFAULT_IGNORE, ...config.ignore];
  const files: RawFile[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const { root, patterns } = resolveInput(input);
    const matched = globbySync(patterns, {
      cwd: root,
      gitignore: true,
      ignoreFiles: [".gitignore", ".ragkitignore"],
      ignore,
      dot: false,
      onlyFiles: true,
      absolute: false,
    });

    for (const rel of matched) {
      const absPath = path.join(root, rel);
      if (seen.has(absPath)) continue;
      const ext = path.extname(absPath).toLowerCase();
      if (!SUPPORTED_EXTS.includes(ext as (typeof SUPPORTED_EXTS)[number])) {
        continue;
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let buf: Buffer;
      try {
        buf = readFileSync(absPath);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;

      seen.add(absPath);
      const content = buf.toString("utf8");
      const source = toPosix(path.relative(root, absPath));
      const dir = toPosix(path.dirname(source));
      const mtime = Math.floor(stat.mtimeMs);

      files.push({
        source,
        absPath,
        ext,
        dir,
        mtime,
        content,
        contentHash: sha256(content),
        metadata: { ext, relPath: source, dir, mtime },
      });
    }
  }

  return files;
}

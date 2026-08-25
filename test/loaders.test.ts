import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadFiles } from "../src/core/loaders.js";
import { RagConfigSchema, type RagConfig } from "../src/config.js";

let dir: string;

const config: RagConfig = RagConfigSchema.parse({});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ragkit-load-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, contents: string | Buffer): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function sources(inputs: string[], cfg: RagConfig = config): string[] {
  return loadFiles(inputs, cfg)
    .map((f) => f.source)
    .sort();
}

describe("loaders (I1)", () => {
  it("returns only supported extensions", () => {
    write("a.md", "# a");
    write("b.ts", "const b = 1;");
    write("c.png", "not-real");
    write("d.exe", "nope");
    write("e.yaml", "k: v");

    expect(sources([dir])).toEqual(["a.md", "b.ts", "e.yaml"]);
  });

  it("excludes default noise directories", () => {
    write("keep.md", "# keep");
    write("node_modules/pkg/index.js", "x");
    write(".git/config", "x");
    write("dist/out.js", "x");
    write("build/out.js", "x");
    write(".next/page.js", "x");

    expect(sources([dir])).toEqual(["keep.md"]);
  });

  it("excludes files larger than 1 MB", () => {
    write("big.txt", "a".repeat(1024 * 1024 + 1));
    write("small.txt", "ok");

    expect(sources([dir])).toEqual(["small.txt"]);
  });

  it("excludes binary files even with supported extensions", () => {
    write("bin.json", Buffer.from([0x7b, 0x00, 0x7d]));
    write("good.json", '{"k":1}');

    expect(sources([dir])).toEqual(["good.json"]);
  });

  it("honors .gitignore and .ragkitignore", () => {
    write(".gitignore", "ignored-git.md\n");
    write(".ragkitignore", "ignored-rag.md\n");
    write("ignored-git.md", "x");
    write("ignored-rag.md", "x");
    write("kept.md", "x");

    expect(sources([dir])).toEqual(["kept.md"]);
  });

  it("honors config ignore patterns", () => {
    write("keep.md", "x");
    write("secret.txt", "x");
    const cfg = RagConfigSchema.parse({ ignore: ["**/*.txt"] });

    expect(sources([dir], cfg)).toEqual(["keep.md"]);
  });

  it("root-relative source uses forward slashes", () => {
    write("sub/deep/note.md", "x");
    const files = loadFiles([dir], config);
    const file = files.find((f) => f.source.endsWith("note.md"));

    expect(file?.source).toBe("sub/deep/note.md");
    expect(file?.dir).toBe("sub/deep");
    expect(file?.metadata).toEqual({
      ext: ".md",
      relPath: "sub/deep/note.md",
      dir: "sub/deep",
      mtime: file?.mtime,
    });
  });

  it("accepts a single file path", () => {
    write("only.md", "x");
    write("other.md", "y");
    const abs = path.join(dir, "only.md");

    expect(sources([abs])).toEqual(["only.md"]);
  });

  it("accepts a glob pattern", () => {
    write("a.md", "x");
    write("b.ts", "y");
    const glob = path.join(dir, "**/*.md");

    expect(sources([glob])).toEqual(["a.md"]);
  });

  it("computes a stable sha256 contentHash of the content", () => {
    write("h.md", "hello");
    const [file] = loadFiles([dir], config);

    expect(file?.contentHash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

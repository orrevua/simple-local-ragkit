import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, RagConfigSchema, defineConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ragkit-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, "utf8");
}

describe("config loading (B3)", () => {
  it("defineConfig is an identity function", () => {
    const input = { collection: "x" };
    expect(defineConfig(input)).toBe(input);
  });

  it("loads a sample .ts config and applies defaults", async () => {
    write(
      "ragkit.config.ts",
      `import { defineConfig } from ${JSON.stringify(
        path.join(process.cwd(), "src/config.ts").replace(/\\/g, "/"),
      )};
export default defineConfig({
  collection: "trabalho",
  roots: ["~/notas"],
});`,
    );

    const config = await loadConfig(dir);
    expect(config.collection).toBe("trabalho");
    expect(config.chunking).toEqual({ size: 800, overlap: 120 });
    expect(config.retrieval).toEqual({
      topK: 8,
      minScore: 0.3,
      contextTokens: 4000,
      rrfK: 60,
    });
    expect(config.embeddings).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434",
    });
    expect(config.ignore).toEqual([]);
  });

  it("expands ~ to homedir and normalizes to forward slashes", async () => {
    write(
      "ragkit.config.ts",
      `export default {
  dbPath: "~/.ragkit/pessoal.db",
  roots: ["~/notas", "~/projetos/*/docs"],
};`,
    );

    const config = await loadConfig(dir);
    const home = os.homedir().replace(/\\/g, "/");
    expect(config.dbPath).toBe(`${home}/.ragkit/pessoal.db`);
    expect(config.roots[0]).toBe(`${home}/notas`);
    expect(config.roots[1]).toBe(`${home}/projetos/*/docs`);
    expect(config.dbPath).not.toContain("\\");
  });

  it("rejects an invalid config with a readable error", async () => {
    write(
      "ragkit.config.ts",
      `export default { retrieval: { topK: "many" } };`,
    );

    await expect(loadConfig(dir)).rejects.toThrow(/Invalid ragkit config/);
  });

  it("throws when no config file exists", async () => {
    await expect(loadConfig(dir)).rejects.toThrow(/No ragkit config found/);
  });

  it("schema applies all defaults on an empty object", () => {
    const config = RagConfigSchema.parse({});
    expect(config.collection).toBe("pessoal");
    expect(config.dbPath).toBe("~/.ragkit/pessoal.db");
    expect(config.roots).toEqual([]);
  });
});

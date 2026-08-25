import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagConfigSchema, type RagConfig } from "../src/config.js";
import { runChecks, type FetchLike } from "../src/cli/commands/doctor.js";
import { loadVecExtension, migrate, openDb } from "../src/core/store.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ragkit-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function config(): RagConfig {
  return RagConfigSchema.parse({
    collection: "pessoal",
    dbPath: path.join(tmp, "test.db"),
    embeddings: { model: "nomic-embed-text" },
  });
}

function createDb(): void {
  const db = openDb(path.join(tmp, "test.db"));
  try {
    loadVecExtension(db);
    migrate(db);
  } finally {
    db.close();
  }
}

function okFetch(models: string[]): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: models.map((name) => ({ name })) }),
  });
}

describe("doctor runChecks", () => {
  it("passes all checks when Ollama and model are present", async () => {
    createDb();
    const results = await runChecks(config(), okFetch(["nomic-embed-text:latest"]));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.name === "database integrity")?.ok).toBe(true);
  });

  it("fails reachable + model when Ollama refuses connection", async () => {
    createDb();
    const refusing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const results = await runChecks(config(), refusing);
    expect(results.find((r) => r.name === "ollama reachable")?.ok).toBe(false);
    expect(results.find((r) => r.name === "embed model pulled")?.ok).toBe(false);
    expect(results.find((r) => r.name === "database integrity")?.ok).toBe(true);
  });

  it("flags a missing embed model as not pulled", async () => {
    createDb();
    const results = await runChecks(config(), okFetch(["some-other-model"]));
    expect(results.find((r) => r.name === "ollama reachable")?.ok).toBe(true);
    const model = results.find((r) => r.name === "embed model pulled");
    expect(model?.ok).toBe(false);
    expect(model?.detail).toContain("ollama pull");
  });

  it("fails the database check when the db file is missing", async () => {
    const results = await runChecks(config(), okFetch(["nomic-embed-text:latest"]));
    expect(results.find((r) => r.name === "database integrity")?.ok).toBe(false);
    expect(results.find((r) => r.name === "database integrity")?.detail).toContain(
      "does not exist",
    );
  });
});

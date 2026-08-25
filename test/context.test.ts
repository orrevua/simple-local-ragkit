import { describe, it, expect } from "vitest";
import { buildContext } from "../src/core/context.js";
import type { Chunk, RankedResult } from "../src/core/types.js";

function ranked(
  rank: number,
  chunk: Partial<Chunk> & { id: string },
  normalizedScore = 1,
): RankedResult {
  return {
    chunkId: chunk.id,
    rank,
    score: normalizedScore,
    normalizedScore,
    chunk: {
      documentId: `doc-${chunk.id}`,
      idx: 0,
      text: "body",
      tokenEstimate: 10,
      ...chunk,
    },
  };
}

describe("buildContext (R3)", () => {
  it("renders code and docs headers per §4.6", () => {
    const results = [
      ranked(1, {
        id: "c1",
        source: "src/core/store.ts",
        startLine: 41,
        endLine: 78,
        headingPath: "class SqliteStore > upsert",
        text: "code body",
      }),
      ranked(2, {
        id: "c2",
        source: "docs/setup.md",
        headingPath: "Instalação > Requisitos",
        text: "docs body",
      }),
    ];

    const { text, sources } = buildContext(results, 4000);

    expect(text).toContain(
      "[1] src/core/store.ts:41-78 — class SqliteStore > upsert",
    );
    expect(text).toContain("[2] docs/setup.md § Instalação > Requisitos");
    expect(text.startsWith("<context>\n")).toBe(true);
    expect(text.endsWith("\n</context>")).toBe(true);
    expect(text).toContain("code body");
    expect(text).toContain("docs body");

    expect(sources).toEqual([
      {
        n: 1,
        source: "src/core/store.ts",
        headingPath: "class SqliteStore > upsert",
        lines: "41-78",
        score: 1,
      },
      {
        n: 2,
        source: "docs/setup.md",
        headingPath: "Instalação > Requisitos",
        lines: undefined,
        score: 1,
      },
    ]);
  });

  it("drops whole chunks that exceed the budget without splitting", () => {
    const results = [
      ranked(1, { id: "c1", source: "a.md", text: "AAAA", tokenEstimate: 30 }),
      ranked(2, { id: "c2", source: "b.md", text: "BBBB", tokenEstimate: 30 }),
      ranked(3, { id: "c3", source: "c.md", text: "CCCC", tokenEstimate: 30 }),
    ];

    const { text, sources, dropped } = buildContext(results, 50);

    expect(sources.map((s) => s.source)).toEqual(["a.md"]);
    expect(text).toContain("AAAA");
    expect(text).not.toContain("BBBB");
    expect(dropped.map((d) => d.source)).toEqual(["b.md", "c.md"]);
    expect(dropped[0]!.reason).toMatch(/token budget/);
  });

  it("numbers sources to match the emitted headers", () => {
    const results = [
      ranked(1, { id: "c1", source: "a.md", tokenEstimate: 100 }),
      ranked(2, { id: "c2", source: "b.md", tokenEstimate: 1 }),
    ];

    const { text, sources } = buildContext(results, 5);

    // First chunk too big, second fits and becomes [1].
    expect(sources).toHaveLength(1);
    expect(sources[0]!.n).toBe(1);
    expect(sources[0]!.source).toBe("b.md");
    expect(text).toContain("[1] b.md");
  });
});

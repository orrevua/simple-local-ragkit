import { describe, it, expect } from "vitest";
import { markdownChunker } from "../src/core/chunker.js";

describe("markdownChunker (I2)", () => {
  it("accumulates a nested headingPath", () => {
    const md = [
      "# A",
      "intro",
      "## B",
      "body of b",
      "### C",
      "body of c",
      "## D",
      "body of d",
    ].join("\n");

    const chunks = markdownChunker(md);
    const paths = chunks.map((c) => c.headingPath);

    expect(paths).toContain("A");
    expect(paths).toContain("A > B");
    expect(paths).toContain("A > B > C");
    expect(paths).toContain("A > D");
  });

  it("assigns sequential idx and a chars/4 tokenEstimate", () => {
    const chunks = markdownChunker("# H\nhello world");
    expect(chunks[0]!.idx).toBe(0);
    expect(chunks[0]!.tokenEstimate).toBe(Math.ceil(chunks[0]!.text.length / 4));
  });

  it("splits oversized sections while preserving headingPath", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line number ${i}`);
    const md = `# Big\n${lines.join("\n")}`;

    const chunks = markdownChunker(md, { size: 200, overlap: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.headingPath).toBe("Big");
      expect(c.text.length).toBeLessThanOrEqual(200 + 40);
    }
  });

  it("never splits in the middle of a line", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `unique-token-${i} some padding text here`,
    );
    const md = `# S\n${lines.join("\n")}`;

    const chunks = markdownChunker(md, { size: 150, overlap: 30 });

    for (const c of chunks) {
      for (const line of c.text.split("\n")) {
        if (line.trim() === "") continue;
        expect(md).toContain(line);
      }
    }
  });

  it("returns drafts without id or documentId", () => {
    const chunks = markdownChunker("# H\ntext");
    expect(chunks[0]).not.toHaveProperty("id");
    expect(chunks[0]).not.toHaveProperty("documentId");
  });
});

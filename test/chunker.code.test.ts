import { describe, it, expect } from "vitest";
import { codeChunker, chunkFile } from "../src/core/chunker.js";

const TS_SRC = `function alpha(a: number): number {
  return a + 1;
}

function beta(b: string): string {
  return b.toUpperCase();
}
`;

describe("codeChunker (I3)", () => {
  it("captures the parent signature into headingPath with 1-based lines", () => {
    const chunks = codeChunker(TS_SRC);

    expect(chunks.length).toBe(2);
    const alpha = chunks.find((c) => c.headingPath?.includes("alpha"));
    const beta = chunks.find((c) => c.headingPath?.includes("beta"));

    expect(alpha?.headingPath).toBe("function alpha(a: number): number {");
    expect(alpha?.startLine).toBe(1);
    expect(alpha?.endLine).toBe(3);

    expect(beta?.headingPath).toBe("function beta(b: string): string {");
    expect(beta?.startLine).toBe(5);
    expect(beta?.endLine).toBe(7);
  });

  it("records deterministic idx", () => {
    const chunks = codeChunker(TS_SRC);
    expect(chunks.map((c) => c.idx)).toEqual([0, 1]);
  });

  it("dispatches code extensions to the code chunker", () => {
    const chunks = chunkFile({ ext: ".ts", content: TS_SRC });
    expect(chunks.every((c) => c.startLine !== undefined)).toBe(true);
  });

  it("dispatches markdown extensions to the markdown chunker", () => {
    const chunks = chunkFile({ ext: ".md", content: "# Title\nbody" });
    expect(chunks[0]!.headingPath).toBe("Title");
    expect(chunks[0]!.startLine).toBeUndefined();
  });
});

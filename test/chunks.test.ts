import { describe, expect, it } from "vitest";
import { formatChunks } from "../src/cli/commands/chunks.js";
import { markdownChunker } from "../src/core/chunker.js";

describe("ragkit chunks (learning mode)", () => {
  it("shows boundaries, headings and a size summary", () => {
    const md = "# Title\n\nintro text\n\n## Setup\n\ninstall it\n";
    const drafts = markdownChunker(md, { size: 800, overlap: 0 });
    const out = formatChunks("a.md", drafts, { size: 800, overlap: 0 });

    expect(out).toContain(`a.md: ${drafts.length} chunks (size=800 overlap=0 tokens)`);
    expect(out).toMatch(/#0 {2}~\d+ tokens/);
    expect(out).toContain("heading:");
    expect(out).toContain("token estimate per chunk:");
  });

  it("prints line ranges when the chunker provides them", () => {
    const out = formatChunks(
      "a.ts",
      [{ idx: 0, text: "const a = 1;", startLine: 1, endLine: 1, tokenEstimate: 3 }],
      { size: 800, overlap: 0 },
    );
    expect(out).toContain("#0  lines 1-1  ~3 tokens");
  });
});

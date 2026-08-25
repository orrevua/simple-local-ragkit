export type ChunkDraft = {
  idx: number;
  text: string;
  headingPath?: string;
  startLine?: number;
  endLine?: number;
  tokenEstimate: number;
};

export type ChunkOptions = {
  size?: number;
  overlap?: number;
};

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".txt"]);

const DEFAULT_SIZE = 800;
const DEFAULT_OVERLAP = 120;

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Recursive char splitter over whole lines. Accumulates lines into windows of
 * at most `size` chars, carrying `overlap` chars of trailing lines into the
 * next window. Never splits mid-line.
 */
function splitLines(text: string, size: number, overlap: number): string[] {
  const lines = text.split("\n");
  const pieces: string[] = [];
  let buf: string[] = [];
  let len = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    pieces.push(buf.join("\n"));
    if (overlap <= 0) {
      buf = [];
      len = 0;
      return;
    }
    const carry: string[] = [];
    let carryLen = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf[i]!;
      if (carryLen + line.length > overlap && carry.length > 0) break;
      carry.unshift(line);
      carryLen += line.length + 1;
    }
    buf = carry;
    len = carryLen;
  };

  for (const line of lines) {
    if (len > 0 && len + line.length + 1 > size) {
      flush();
    }
    buf.push(line);
    len += line.length + 1;
  }
  flush();

  return pieces.filter((p) => p.trim().length > 0);
}

type Section = {
  headingPath: string;
  lines: string[];
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Markdown chunker: splits by ATX headings, accumulating a `headingPath`
 * ("A > B"). Sections larger than `size` fall through to a recursive char
 * splitter that preserves the section's `headingPath`.
 */
export function markdownChunker(
  text: string,
  opts: ChunkOptions = {},
): ChunkDraft[] {
  const size = opts.size ?? DEFAULT_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const lines = text.split("\n");
  const sections: Section[] = [];
  const pathStack: string[] = [];
  let current: Section = { headingPath: "", lines: [] };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (current.lines.length > 0 || current.headingPath) {
        sections.push(current);
      }
      const level = m[1]!.length;
      const title = m[2]!.trim();
      pathStack.length = level - 1;
      pathStack[level - 1] = title;
      const headingPath = pathStack.filter(Boolean).join(" > ");
      current = { headingPath, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.headingPath) {
    sections.push(current);
  }

  const drafts: ChunkDraft[] = [];
  let idx = 0;
  for (const section of sections) {
    const body = section.lines.join("\n");
    if (body.trim().length === 0) continue;
    const pieces =
      body.length <= size ? [body] : splitLines(body, size, overlap);
    for (const piece of pieces) {
      drafts.push({
        idx: idx++,
        text: piece,
        headingPath: section.headingPath || undefined,
        tokenEstimate: tokenEstimate(piece),
      });
    }
  }

  return drafts;
}

function indentWidth(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

type CodeBlock = {
  signature: string;
  start: number;
  end: number;
};

/**
 * Splits code into top-level blocks by a brace/indent heuristic (no AST).
 * A new top-level block starts at each non-blank, non-indented line; its first
 * line is captured as the parent signature into `headingPath`. Records 1-based
 * `startLine`/`endLine`. Oversized blocks fall through to the char splitter.
 */
export function codeChunker(
  text: string,
  opts: ChunkOptions = {},
): ChunkDraft[] {
  const size = opts.size ?? DEFAULT_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const lines = text.split("\n");

  const blocks: CodeBlock[] = [];
  let currentStart = -1;
  let signature = "";

  const closeAt = (endLine: number): void => {
    if (currentStart === -1) return;
    let end = endLine;
    while (end > currentStart && lines[end]!.trim().length === 0) {
      end -= 1;
    }
    blocks.push({ signature, start: currentStart, end });
    currentStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const isCloser = /^[)}\]]/.test(trimmed);
    if (indentWidth(line) === 0 && !isCloser) {
      closeAt(i - 1 >= 0 ? i - 1 : i);
      currentStart = i;
      signature = trimmed;
    } else if (currentStart !== -1) {
      // trailing closer/indented line extends the open block
    }
  }
  // extend each block's end through following closers/blank lines
  for (let i = 0; i < lines.length; i++) void lines[i];
  closeAt(lines.length - 1);

  if (blocks.length === 0 && lines.some((l) => l.trim().length > 0)) {
    blocks.push({ signature: "", start: 0, end: lines.length - 1 });
  }

  const drafts: ChunkDraft[] = [];
  let idx = 0;
  for (const block of blocks) {
    const body = lines.slice(block.start, block.end + 1).join("\n");
    if (body.trim().length === 0) continue;
    const headingPath = block.signature || undefined;
    if (body.length <= size) {
      drafts.push({
        idx: idx++,
        text: body,
        headingPath,
        startLine: block.start + 1,
        endLine: block.end + 1,
        tokenEstimate: tokenEstimate(body),
      });
      continue;
    }
    let offset = block.start;
    for (const piece of splitLines(body, size, overlap)) {
      const pieceLines = piece.split("\n").length;
      const startLine = offset + 1;
      const endLine = offset + pieceLines;
      drafts.push({
        idx: idx++,
        text: piece,
        headingPath,
        startLine,
        endLine: Math.min(endLine, block.end + 1),
        tokenEstimate: tokenEstimate(piece),
      });
      offset += pieceLines;
    }
  }

  return drafts;
}

/** Dispatch by extension: markdown/text vs. code. */
export function chunkFile(
  file: { ext: string; content: string },
  opts: ChunkOptions = {},
): ChunkDraft[] {
  if (MARKDOWN_EXTS.has(file.ext.toLowerCase())) {
    return markdownChunker(file.content, opts);
  }
  return codeChunker(file.content, opts);
}

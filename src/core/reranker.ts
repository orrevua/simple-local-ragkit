import type { Chunk } from "./types.js";

/**
 * A reranker re-scores a small candidate pool with a more expensive signal
 * than the first-stage retrievers. Production setups usually plug in a
 * cross-encoder (e.g. bge-reranker) here; the interface only needs one score
 * per candidate, higher = more relevant.
 */
export interface Reranker {
  readonly name: string;
  score(query: string, chunks: Chunk[]): Promise<number[]>;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from how i in is it of on or " +
    "the this to what when where which who why with you your o a os as de " +
    "da do das dos e em é um uma para por com que como qual"
  ).split(" "),
);

export function contentTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

/**
 * Offline reranker: the share of distinct query terms a chunk contains, with
 * a bonus for terms that appear in its heading path. BM25 rewards a chunk
 * that repeats one rare term many times; coverage rewards a chunk that
 * answers *all* parts of the question, which is often what you want after
 * fusion. Cheap, deterministic and explainable, so it doubles as a lesson in
 * why two-stage retrieval works.
 */
export class TermCoverageReranker implements Reranker {
  readonly name = "term-coverage";

  async score(query: string, chunks: Chunk[]): Promise<number[]> {
    const terms = contentTerms(query);
    if (terms.length === 0) return chunks.map(() => 0);
    return chunks.map((chunk) => {
      const body = new Set(contentTerms(chunk.text));
      const heading = new Set(contentTerms(chunk.headingPath ?? ""));
      let hits = 0;
      for (const t of terms) {
        if (body.has(t)) hits += 1;
        if (heading.has(t)) hits += 0.5;
      }
      return hits / (terms.length * 1.5);
    });
  }
}

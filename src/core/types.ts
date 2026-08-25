export type Document = {
  id: string;
  collection: string;
  source: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  mtime: number;
  createdAt: number;
};

export type Chunk = {
  id: string;
  documentId: string;
  idx: number;
  text: string;
  headingPath?: string;
  startLine?: number;
  endLine?: number;
  tokenEstimate: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type SearchResult = {
  chunkId: string;
  rank: number;
  rawScore: number;
  chunk: Chunk;
};

export type StoreStats = {
  documents: number;
  chunks: number;
};

export type CollectionSummary = {
  name: string;
  documents: number;
  chunks: number;
};

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface Store {
  upsertCollection(
    name: string,
    dimensions: number,
    embedModel: string,
  ): void;
  getDocumentBySource(
    collection: string,
    source: string,
  ): Document | undefined;
  insertDocument(doc: Document): void;
  deleteDocument(id: string): void;
  replaceChunks(
    documentId: string,
    chunks: Chunk[],
    embeddings: number[][],
  ): void;
  denseSearch(queryVec: number[], k: number): SearchResult[];
  lexicalSearch(query: string, k: number): SearchResult[];
  stats(): StoreStats;
  listCollections(): CollectionSummary[];
  getDocumentChunks(documentId: string): Chunk[];
}

export type MetadataFilter = Record<
  string,
  string | number | boolean | { $in: Array<string | number | boolean> }
>;

export type HybridSearchOptions = {
  topK?: number;
  filter?: MetadataFilter;
};

/** A fused, ranked chunk with its normalized score and the RRF breakdown. */
export type RankedResult = {
  chunkId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  chunk: Chunk;
};

/** Per-chunk RRF math, for `--explain`. */
export type RrfEntry = {
  chunkId: string;
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
  normalizedScore: number;
};

export type HybridExplain = {
  query: string;
  topK: number;
  rrfK: number;
  minScore: number;
  dense: SearchResult[];
  lexical: SearchResult[];
  fused: RrfEntry[];
  maxFusedScore: number;
};

export type HybridSearchResult = {
  results: RankedResult[];
  explain: HybridExplain;
};

export interface Retriever {
  hybridSearch(
    query: string,
    options?: HybridSearchOptions,
  ): Promise<HybridSearchResult>;
}

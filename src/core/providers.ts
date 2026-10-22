import { createHash } from "node:crypto";
import type { RagConfig } from "../config.js";
import { RagError } from "./errors.js";
import {
  OllamaEmbeddings,
  SqliteEmbeddingCache,
  type EmbeddingCache,
} from "./embedder.js";
import type { Db } from "./store.js";
import type { EmbeddingProvider } from "./types.js";

/** The vector table is declared `float[768]`, so every provider must match. */
export const EMBED_DIMENSIONS = 768;
const BATCH_SIZE = 64;

export class EmbeddingProviderError extends RagError {
  readonly code = "EMBEDDING_PROVIDER";
}

/**
 * Feature-hashing embedder: every word (and word bigram) is hashed into one of
 * 768 buckets with a +/-1 sign, then the vector is L2-normalized. No model, no
 * network, fully deterministic.
 *
 * It only captures *lexical* overlap, never meaning ("car" and "automobile"
 * share nothing), which makes it a useful teaching baseline: compare it with a
 * real model in `ragkit eval --compare` and you see exactly what semantic
 * embeddings buy you.
 */
export class HashEmbeddings implements EmbeddingProvider {
  readonly model = "hash-768";
  readonly dimensions = EMBED_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
}

export function hashEmbed(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const features = [...words];
  for (let i = 0; i + 1 < words.length; i++) {
    features.push(`${words[i]} ${words[i + 1]}`);
  }
  for (const f of features) {
    const digest = createHash("md5").update(f).digest();
    const bucket = digest.readUInt32LE(0) % dimensions;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vec[bucket]! += sign;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

export type OpenAICompatibleOptions = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
};

/**
 * Any server speaking the OpenAI `/v1/embeddings` API. Requests `dimensions`
 * explicitly (text-embedding-3-* support shortening), and caches results in
 * the same SQLite table as the Ollama provider.
 */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    private readonly cache: EmbeddingCache,
    options: OpenAICompatibleOptions,
  ) {
    this.model = options.model;
    this.dimensions = options.dimensions ?? EMBED_DIMENSIONS;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.apiKey = options.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[] | undefined>(texts.length);
    const misses: { index: number; text: string; hash: string }[] = [];
    texts.forEach((text, index) => {
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      const cached = this.cache.get(hash, this.model);
      if (cached) results[index] = cached;
      else misses.push({ index, text, hash });
    });

    for (let start = 0; start < misses.length; start += BATCH_SIZE) {
      const batch = misses.slice(start, start + BATCH_SIZE);
      const vectors = await this.post(batch.map((m) => m.text));
      batch.forEach(({ index, hash }, j) => {
        this.cache.set(hash, this.model, vectors[j]!);
        results[index] = vectors[j]!;
      });
    }
    return results.map((v) => v!);
  }

  private async post(input: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        input,
        dimensions: this.dimensions,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmbeddingProviderError(
        `${this.baseUrl}/embeddings failed (${res.status}): ${body || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== input.length) {
      throw new EmbeddingProviderError(
        `Expected ${input.length} embeddings, got ${rows.length}.`,
      );
    }
    for (const row of rows) {
      if (row.embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError(
          `Model ${this.model} returned ${row.embedding.length} dimensions; ` +
            `ragkit needs ${this.dimensions}. Pick a model that supports ` +
            "the `dimensions` parameter (e.g. text-embedding-3-small).",
        );
      }
    }
    return rows.map((r) => r.embedding);
  }
}

/**
 * Single place that turns `config.embeddings` into a provider. Every command
 * (ingest, query, eval, mcp, serve) goes through here, so adding a provider is
 * one new class plus one `case`.
 */
export function createEmbedder(config: RagConfig, db: Db): EmbeddingProvider {
  const { provider, model, baseUrl, apiKeyEnv } = config.embeddings;
  switch (provider) {
    case "hash":
      return new HashEmbeddings();
    case "openai":
      return new OpenAICompatibleEmbeddings(new SqliteEmbeddingCache(db), {
        model,
        baseUrl,
        apiKey: process.env[apiKeyEnv],
      });
    case "ollama":
      return new OllamaEmbeddings(db, { model, baseUrl });
  }
}

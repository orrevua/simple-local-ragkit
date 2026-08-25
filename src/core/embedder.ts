import { createHash } from "node:crypto";
import type { Db } from "./store.js";
import { ModelNotFoundError, OllamaUnavailableError } from "./errors.js";
import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_BASE_URL = "http://localhost:11434";
const BATCH_SIZE = 32;
const MAX_ATTEMPTS = 3;

export type EmbeddingCache = {
  get(textHash: string, model: string): number[] | undefined;
  set(textHash: string, model: string, embedding: number[]): void;
};

export type OllamaEmbeddingsOptions = {
  model?: string;
  dimensions?: number;
  baseUrl?: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isConnectionRefused(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  const code =
    (err as { code?: string } | undefined)?.code ??
    (cause as { code?: string } | undefined)?.code;
  return code === "ECONNREFUSED";
}

class SqliteEmbeddingCache implements EmbeddingCache {
  constructor(private readonly db: Db) {}

  get(textHash: string, model: string): number[] | undefined {
    const row = this.db
      .prepare(
        "SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?",
      )
      .get(textHash, model) as { embedding: Buffer } | undefined;
    if (!row) return undefined;
    const f32 = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    return Array.from(f32);
  }

  set(textHash: string, model: string, embedding: number[]): void {
    this.db
      .prepare(
        `INSERT INTO embedding_cache(text_hash, model, embedding, created_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(text_hash) DO UPDATE SET
           model = excluded.model,
           embedding = excluded.embedding`,
      )
      .run(
        textHash,
        model,
        Buffer.from(new Float32Array(embedding).buffer),
        Date.now(),
      );
  }
}

function isCache(value: Db | EmbeddingCache): value is EmbeddingCache {
  return typeof (value as EmbeddingCache).get === "function";
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly cache: EmbeddingCache;

  constructor(
    cache: Db | EmbeddingCache,
    options: OllamaEmbeddingsOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.baseUrl =
      options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
    this.cache = isCache(cache) ? cache : new SqliteEmbeddingCache(cache);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[] | undefined>(texts.length);
    const misses: { index: number; text: string; hash: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const hash = sha256(text);
      const cached = this.cache.get(hash, this.model);
      if (cached) {
        results[i] = cached;
      } else {
        misses.push({ index: i, text, hash });
      }
    }

    for (let start = 0; start < misses.length; start += BATCH_SIZE) {
      const batch = misses.slice(start, start + BATCH_SIZE);
      const embeddings = await this.embedBatch(batch.map((m) => m.text));
      for (let j = 0; j < batch.length; j++) {
        const { index, hash } = batch[j]!;
        const vec = embeddings[j]!;
        this.cache.set(hash, this.model, vec);
        results[index] = vec;
      }
    }

    return results.map((v) => v!);
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.postEmbed(input);
      } catch (err) {
        if (err instanceof ModelNotFoundError) throw err;
        lastError = err;
        if (!isConnectionRefused(err) || attempt === MAX_ATTEMPTS) break;
        await delay(2 ** (attempt - 1) * 100);
      }
    }
    if (isConnectionRefused(lastError)) {
      throw new OllamaUnavailableError(this.baseUrl, { cause: lastError });
    }
    throw lastError;
  }

  private async postEmbed(input: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
      });
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new OllamaUnavailableError(this.baseUrl, { cause: err });
      }
      throw err;
    }

    if (res.status === 404) {
      const body = await res.text().catch(() => "");
      if (/model .*not found|not found.*model/i.test(body)) {
        throw new ModelNotFoundError(this.model);
      }
      throw new Error(
        `Ollama ${this.baseUrl}/api/embed returned 404. ` +
          "Upgrade Ollama to a version that exposes the /api/embed endpoint.",
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (/model .*not found|not found/i.test(body)) {
        throw new ModelNotFoundError(this.model);
      }
      throw new Error(
        `Ollama /api/embed failed (${res.status}): ${body || res.statusText}`,
      );
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
      throw new Error(
        `Ollama returned ${embeddings?.length ?? 0} embeddings for ${input.length} inputs.`,
      );
    }
    for (const vec of embeddings) {
      if (!Array.isArray(vec) || vec.length !== this.dimensions) {
        throw new Error(
          `Ollama returned an embedding of length ${
            Array.isArray(vec) ? vec.length : "n/a"
          }; expected ${this.dimensions}.`,
        );
      }
    }
    return embeddings;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class RagError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class OllamaUnavailableError extends RagError {
  readonly code = "OLLAMA_UNAVAILABLE";

  constructor(baseUrl = "http://localhost:11434", options?: { cause?: unknown }) {
    super(
      `Ollama não respondeu em ${baseUrl}. Rode \`ollama serve\`.`,
      options,
    );
  }
}

export class ModelNotFoundError extends RagError {
  readonly code = "MODEL_NOT_FOUND";

  constructor(model = "nomic-embed-text", options?: { cause?: unknown }) {
    super(
      `Modelo ${model} não encontrado. Rode \`ollama pull ${model}\`.`,
      options,
    );
  }
}

export class DimensionMismatchError extends RagError {
  readonly code = "DIMENSION_MISMATCH";

  constructor(
    expected: number,
    actual: number,
    model = "nomic-embed-text",
    options?: { cause?: unknown },
  ) {
    super(
      `Collection criada com ${expected} dim (${model}); modelo atual gera ${actual}. ` +
        "Use `ragkit init --force` para recriar.",
      options,
    );
  }
}

export class VecExtensionError extends RagError {
  readonly code = "VEC_EXTENSION_LOAD_FAILED";

  constructor(cause: unknown) {
    super(
      "Failed to load the sqlite-vec extension. Ensure the platform package " +
        "(e.g. sqlite-vec-windows-x64) was installed and that better-sqlite3 " +
        "supports extension loading on this system. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

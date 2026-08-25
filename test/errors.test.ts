import { describe, it, expect } from "vitest";
import {
  RagError,
  OllamaUnavailableError,
  ModelNotFoundError,
  DimensionMismatchError,
  VecExtensionError,
} from "../src/core/errors.js";

describe("typed errors (B5)", () => {
  it("OllamaUnavailableError carries code and exact message", () => {
    const err = new OllamaUnavailableError();
    expect(err).toBeInstanceOf(RagError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("OLLAMA_UNAVAILABLE");
    expect(err.message).toBe(
      "Ollama não respondeu em http://localhost:11434. Rode `ollama serve`.",
    );
    expect(err.name).toBe("OllamaUnavailableError");
  });

  it("OllamaUnavailableError reflects a custom base URL", () => {
    const err = new OllamaUnavailableError("http://127.0.0.1:9999");
    expect(err.message).toBe(
      "Ollama não respondeu em http://127.0.0.1:9999. Rode `ollama serve`.",
    );
  });

  it("ModelNotFoundError carries code and exact message", () => {
    const err = new ModelNotFoundError();
    expect(err).toBeInstanceOf(RagError);
    expect(err.code).toBe("MODEL_NOT_FOUND");
    expect(err.message).toBe(
      "Modelo nomic-embed-text não encontrado. Rode `ollama pull nomic-embed-text`.",
    );
  });

  it("DimensionMismatchError carries code and exact message", () => {
    const err = new DimensionMismatchError(768, 1024);
    expect(err).toBeInstanceOf(RagError);
    expect(err.code).toBe("DIMENSION_MISMATCH");
    expect(err.message).toBe(
      "Collection criada com 768 dim (nomic-embed-text); modelo atual gera 1024. " +
        "Use `ragkit init --force` para recriar.",
    );
  });

  it("VecExtensionError carries code, message and cause", () => {
    const cause = new Error("boom");
    const err = new VecExtensionError(cause);
    expect(err).toBeInstanceOf(RagError);
    expect(err.code).toBe("VEC_EXTENSION_LOAD_FAILED");
    expect(err.message).toContain("Failed to load the sqlite-vec extension");
    expect(err.message).toContain("boom");
    expect(err.cause).toBe(cause);
  });
});

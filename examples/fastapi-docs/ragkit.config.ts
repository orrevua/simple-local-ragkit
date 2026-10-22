// Example collection over the FastAPI tutorial. Switch `provider` to
// "ollama" (default model nomic-embed-text) to compare a real embedding model
// against the offline hash baseline.
export default {
  collection: "fastapi-tutorial",
  dbPath: "./fastapi-tutorial.db",
  roots: ["./docs"],
  embeddings: { provider: "hash" },
  retrieval: { minScore: 0 },
};

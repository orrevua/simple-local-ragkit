# Backlog

This file tracks intentionally deferred work after the MVP.

## Deferred on purpose

- pgvector or another non-SQLite vector backend for teams that outgrow the
  local SQLite model.
- Retrieval evals and benchmark harnesses for measuring answer quality over a
  fixed corpus.
- HTTP API surface for remote clients that do not speak MCP.
- Web panel for browsing collections, documents, and retrieval traces.
- Additional loaders such as PDF, DOCX, and other rich document formats.
- Older Ollama endpoint fallback for environments that do not yet expose
  `/api/embed`.

## Not in scope for the MVP

The MVP stays local-first, file-system driven, and offline. Anything that would
change that shape belongs here until there is a clear product reason to move it
forward.
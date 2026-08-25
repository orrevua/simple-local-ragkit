# RAGKit MVP — Implementation Spec

**Status:** Draft
**Date:** 2026-07-20
**Related:** `RAGKIT-SPEC-v2.md` (source technical spec, PT-BR)

## Goal
Turn `RAGKIT-SPEC-v2.md` into a concrete, ordered set of implementation units for a single TypeScript package (`ragkit`): a local-first hybrid-RAG tool with a CLI and an MCP stdio server, running 100% offline on SQLite + Ollama. This document is the coding contract; the source spec is the product intent.

## Target Environment
- **OS:** Windows 11 (dev). PowerShell syntax for all commands (`$null`, `$env:VAR`, backtick continuation). Must not hardcode POSIX-only paths.
- **Runtime:** Node.js ≥ 20 (native `fetch`, `node:test`-era APIs available; we use `vitest`).
- **Language:** TypeScript, ESM (`"type": "module"`), single package `ragkit`, no monorepo.
- **External services:** Ollama at `http://localhost:11434` with `nomic-embed-text` pulled (768 dim).
- **Structure:** exactly as Section 2 of the source spec (`src/core`, `src/cli`, `src/mcp`, `src/config.ts`).

---

## 1. Source-Spec Review — Risks & Decisions to Resolve

These MUST be settled before or during the units they affect. Each has a **Decision** the Implementer follows unless the user overrides.

### R1 — `sqlite-vec` loading on Windows/Node (BLOCKER-class)
`chunks_vec USING vec0(...)` requires the `sqlite-vec` extension loaded into `better-sqlite3` at runtime via `db.loadExtension()`. On Windows this needs the prebuilt `.dll` shipped by the `sqlite-vec` npm package, and `better-sqlite3` must be compiled with extension loading enabled (it is, by default). Node's `better-sqlite3` disables extension loading until `db.loadExtension` is called; some builds require `db.unsafeMode(true)` first, and the sqlite-vec entrypoint path differs per-platform.
- **Decision:** Use the official `sqlite-vec` npm package and its `getLoadablePath()` / `load(db)` helper rather than a hardcoded path. Isolate all loading in one function `loadVecExtension(db)` in `store.ts`. If load fails, throw a typed `VecExtensionError` with an actionable message. Verify on the actual Windows machine in Unit B1 before building anything on top of it. **This is the single highest-risk dependency — validate first.**

### R2 — `better-sqlite3` native build on Windows
`better-sqlite3` is a native addon; on Windows it needs prebuilt binaries for the Node ABI or a working `node-gyp` toolchain (Visual Studio Build Tools + Python). Node 20/22 prebuilds are usually available.
- **Decision:** Pin a `better-sqlite3` version with known prebuilds for Node ≥ 20 on win32-x64. Document the fallback (`npm i --build-from-source` needs VS Build Tools) in README. Smoke-test in Unit B1.

### R3 — Ollama `/api/embed` batch behavior
The source spec says batch of 32 against `POST /api/embed`. Ollama's `/api/embed` (newer endpoint, not `/api/embeddings`) accepts `input` as a string **or array**, returning `{ embeddings: number[][] }`. Older Ollama only has `/api/embeddings` (singular, one input, `{ embedding: [...] }`). Behavior and response shape differ by version.
- **Decision:** Target `/api/embed` with array `input`, parse `embeddings`. Validate returned vector count === input count and each length === 768. On 404 for `/api/embed`, throw a typed error instructing an Ollama upgrade (do NOT silently fall back to the singular endpoint in MVP — keep it simple, document the requirement).

### R4 — FTS5 external-content triggers
Schema uses `content='chunks', content_rowid='rowid'` (external-content FTS5). External-content tables do **not** auto-sync; you MUST create `AFTER INSERT/UPDATE/DELETE` triggers on `chunks` that write the special `chunks_fts(chunks_fts, rowid, text)` "delete" rows and insert rows, or the FTS index silently drifts. `chunks.id` is a TEXT uuid, but FTS `content_rowid` maps to the implicit integer `rowid` — the triggers must reference `old.rowid`/`new.rowid`, not `id`.
- **Decision:** Create the three sync triggers in the migration (Unit B2). Standard pattern:
  - insert trigger: `INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);`
  - delete trigger: `INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);`
  - update trigger: delete-row then insert-row.
  Add a test that inserts a chunk and confirms it is findable via `chunks_fts MATCH` (Unit B2 acceptance).

### R5 — `chunks_vec` keyed by TEXT, not rowid
`chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768])`. vec0 supports a TEXT primary key column. Inserts must bind the chunk's uuid and the embedding as a Float32 blob (vec0 accepts JSON arrays or the `vec_f32()` BLOB). Deletes on document re-ingest must also delete from `chunks_vec` by `chunk_id` — there is no FK cascade into a virtual table.
- **Decision:** Store embeddings via `vec_f32(json(...))` or a `Float32Array` buffer bound as BLOB; pick whichever the installed `sqlite-vec` version documents and lock it in Unit B2. On chunk delete, explicitly `DELETE FROM chunks_vec WHERE chunk_id = ?`. The `ON DELETE CASCADE` on `chunks` only covers real tables, so document deletion must delete chunks AND their vec/fts rows inside one transaction.

### R6 — RRF details
Source: `score = Σ 1/(60 + rank_i)`, `rrfK` default 60, `topK*3` candidates per leg. Ambiguities: is `rank` 0-based or 1-based? Chunks appearing in only one leg — do they still get a partial score (yes, sum over present legs only)? Dense distance is cosine *distance* (lower = better) while FTS BM25 in SQLite returns a value where **more negative = better** (SQLite's `bm25()` returns negative scores).
- **Decision:** Use 1-based rank (`rank = 1` for top result). RRF sums `1/(rrfK + rank)` over each leg where the chunk appears; absent-leg contributes 0. Order dense candidates by ascending distance; order FTS candidates by ascending `bm25()` (most negative first). A chunk present in both legs naturally scores higher. `minScore` filters on the final fused RRF score. Document that RRF scores are small (~0.01–0.03) so the default `minScore: 0.3` from the config would filter everything — **flag this contradiction to the user**: `minScore` likely intended for normalized similarity, not raw RRF. **Decision:** apply `minScore` against the max-normalized RRF score (fused / maxFused), OR treat `minScore` as `0` by default in retrieval. Resolve in Unit R3; default to normalized fused score so `0.3` is meaningful.

### R7 — Config as `.ts` file loaded at runtime
`ragkit.config.ts` uses `export default defineConfig({...})`. Loading a `.ts` file at runtime requires either a bundler step or on-the-fly transpilation. Node ≥ 20 cannot `import()` a `.ts` file without a loader (`tsx`, `jiti`, or `--experimental-strip-types` which does not evaluate `defineConfig` imports cleanly across versions).
- **Decision:** Load the config with `jiti` (or `tsx`'s programmatic API) for robust `.ts` import at runtime, no build step required for the user's config. Validate the loaded object with `zod`. `defineConfig` is an identity function exported from the package for editor typing. Expand `~` and env-style paths manually (Windows has no `~` expansion). Support `ragkit.config.ts`, `ragkit.config.js`, and `ragkit.config.mjs` discovery. Locked in Unit B3.

### R8 — Path handling on Windows
`roots: ["~/notas", "~/projetos/*/docs"]` mixes `~` expansion and globs with forward slashes. Windows uses backslashes; globs must be normalized. `.gitignore`/`.ragkitignore` semantics must be honored.
- **Decision:** Normalize all paths to POSIX-style internally for globbing (`fast-glob`/`globby` accept forward slashes on Windows); expand `~` to `os.homedir()`. Store `source` as a path relative to the ingested root, using forward slashes for stable cross-run identity. Locked in Unit I1.

### R9 — MCP stdout purity
Section 6.3.5: nothing but MCP protocol on stdout in `mcp` mode. Any stray `console.log`, progress bar, or dependency banner corrupts stdio transport.
- **Decision:** A single logging module routes ALL output to stderr by default; in `mcp` mode, stdout is owned exclusively by the SDK transport. Add a guard test/assertion. Locked in Unit M1.

### R10 — `--watch` incremental correctness & code chunker heuristic
`chokidar` debounce 500ms reindex single file is straightforward. The **code chunker without an AST** (indentation/brace heuristic) is inherently lossy — acceptance criterion "exact function name search returns the right chunk" is satisfied primarily by the lexical (FTS) leg, not by perfect chunk boundaries.
- **Decision:** Keep the heuristic simple (top-level brace/indent blocks, capture parent signature line into `headingPath`, record `startLine`/`endLine`). Do not over-engineer. Lexical leg carries correctness for exact-name search. Locked in Unit I3.

### R11 — Interface preservation (accepted, low risk)
Principle 4 requires `EmbeddingProvider` / store / retriever interfaces to exist even with one impl. Acceptance criteria explicitly test that pgvector/Gemini could be added without touching `retriever.ts` or CLI.
- **Decision:** `retriever.ts` depends only on abstract `Store` and `EmbeddingProvider` interfaces (defined in `types.ts`), never on `SqliteStore` or `OllamaEmbeddings` concretely. Dependency injection through constructors/factory in `context.ts`/CLI wiring.

---

## 2. Proposed Design (summary)

Layered core with injected interfaces:

```
types.ts        -> Document, Chunk, Store, EmbeddingProvider, Retriever, SearchResult, RagConfig (zod-derived)
config.ts       -> loadConfig() (jiti + zod), defineConfig(), path expansion
store.ts        -> SqliteStore implements Store: migrations, upsertDocument, replaceChunks,
                   denseSearch, lexicalSearch, deleteDocument, stats, loadVecExtension
loaders.ts      -> walk/glob + ignore rules -> RawFile[]
chunker.ts      -> markdownChunker, codeChunker -> Chunk[] (dispatch by ext)
embedder.ts     -> OllamaEmbeddings implements EmbeddingProvider + embedding_cache
retriever.ts    -> hybridSearch(query): dense + lexical + RRF + metadata filter + minScore
context.ts      -> buildContext(results, budget) -> { text, sources }
cli/*           -> commander wiring: init, ingest, query, stats, doctor, mcp
mcp/*           -> stdio server, 3 tools (search_context, list_collections, get_document)
```

Data flow: `loaders -> chunker -> embedder(+cache) -> store.replaceChunks` (ingest);
`query -> embedder -> store.denseSearch + store.lexicalSearch -> RRF -> context builder` (retrieve).

---

## 3. Scope

- **In scope:** everything in source spec Sections 3–9 for the MVP: SQLite schema, incremental ingest, hybrid retrieval + RRF + `--explain`, 3-tool MCP stdio server, CLI (`init`, `ingest`, `query`, `stats`, `doctor`, `mcp`), `--watch`, config loading, typed errors, ≥ 80% coverage on `src/core`.
- **Out of scope (explicit, per source non-objectives):** HTTP API, web panel, job queue, pgvector/Qdrant, reranking, eval suite, `eject`, multiple embedding providers, PDF/docx loaders.

---

## 4. Implementation Units

Ordered by dependency, following source Section 9 (Base → Ingestion → Retrieval → MCP → Polish). Each ~50 LOC unless noted. `[core]` units are the ones counting toward the ≥80% coverage bar.

### Phase 0 — Base

**B0. Package scaffold & tooling**
- Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.ragkitignore` (sample), `src/index.ts` (empty barrel).
- Change: ESM package `ragkit`, `bin: { ragkit: "dist/cli/index.js" }`, scripts (`build`, `test`, `dev`), deps declared: `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk`, `commander`, `picocolors`, `zod`, `chokidar`, `globby`, `jiti`; devDeps: `typescript`, `vitest`, `@types/node`, `@types/better-sqlite3`.
- Acceptance: `rtk npm install` succeeds on Windows; `rtk npx tsc --noEmit` passes on empty tree; `rtk npx vitest run` runs zero tests green.
- Deps: none.

**B1. SQLite + sqlite-vec smoke test (RISK SPIKE — R1, R2)** `[core]`
- Files: `src/core/store.ts` (partial: `openDb`, `loadVecExtension`), `test/store.vec.test.ts`.
- Change: open a `better-sqlite3` db, load `sqlite-vec`, run `SELECT vec_version()` and a trivial `vec0` insert+KNN query. Typed `VecExtensionError` on failure.
- Acceptance: test proves sqlite-vec loads and a `MATCH ... ORDER BY distance` KNN query returns rows **on this Windows machine**. If it fails, STOP and report to user before proceeding.
- Deps: B0.

**B2. Schema, migrations & FTS/vec triggers (R4, R5)** `[core]`
- Files: `src/core/store.ts` (schema/migration block), `test/store.schema.test.ts`.
- Change: create all tables from Section 3 plus the three FTS5 external-content sync triggers; idempotent migration guarded by `PRAGMA user_version`. Enable `PRAGMA foreign_keys=ON`, `journal_mode=WAL`.
- Acceptance: fresh db creates all tables/triggers; inserting a `chunks` row makes it findable via `chunks_fts MATCH`; deleting the row removes it from FTS; `user_version` bumped and re-running migration is a no-op.
- Deps: B1.

**B3. Config loading & types (R7, R8)** `[core]`
- Files: `src/config.ts`, `src/core/types.ts`, `test/config.test.ts`.
- Change: `RagConfigSchema` (zod) matching Section 7 with defaults; `defineConfig()` identity fn; `loadConfig(cwd)` discovers + loads `.ts/.js/.mjs` via jiti, validates, expands `~` and normalizes paths. `types.ts` holds `Document`, `Chunk`, `SearchResult`, `Store`, `EmbeddingProvider`, `Retriever` interfaces.
- Acceptance: loads a sample `ragkit.config.ts`, applies defaults for omitted fields, expands `~` to `os.homedir()`, rejects invalid config with a readable zod error.
- Deps: B0.

**B4. Store CRUD: documents & chunks (R5)** `[core]`
- Files: `src/core/store.ts` (`SqliteStore` methods), `test/store.crud.test.ts`.
- Change: `upsertCollection`, `getDocumentBySource`, `insertDocument`, `deleteDocument` (cascades chunks + explicit `chunks_vec` delete in one txn), `replaceChunks(docId, chunks, embeddings)` (delete old + insert into `chunks`, `chunks_vec`), `stats()`.
- Acceptance: insert doc + chunks + embeddings; `stats()` reports correct counts; `deleteDocument` removes rows from `documents`, `chunks`, `chunks_fts`, `chunks_vec`; re-`replaceChunks` fully swaps chunk set.
- Deps: B2, B3.

**B5. Typed errors module** `[core]`
- Files: `src/core/errors.ts`, `test/errors.test.ts`.
- Change: `RagError` base + `OllamaUnavailableError`, `ModelNotFoundError`, `DimensionMismatchError`, `VecExtensionError` (from B1), each with actionable message per Section 8.
- Acceptance: each error carries a stable `code` and the exact user-facing message; `instanceof RagError` holds.
- Deps: B0.

### Phase 1 — Ingestion

**I1. Loaders + ignore rules (R8)** `[core]`
- Files: `src/core/loaders.ts`, `test/loaders.test.ts`.
- Change: accept folder/file/glob; recursive walk via `globby`; honor `.gitignore` + `.ragkitignore` + config `ignore`; skip `node_modules`, `.git`, `dist`, `build`, `.next`, files > 1 MB, binaries; attach metadata `{ ext, relPath, dir, mtime }`; compute `contentHash` (sha256). Returns `RawFile[]`.
- Acceptance: given a temp tree, returns only supported extensions, excludes ignored dirs and >1MB files, `relPath` uses forward slashes and is root-relative.
- Deps: B3.

**I2. Markdown chunker** `[core]`
- Files: `src/core/chunker.ts` (markdown path), `test/chunker.md.test.ts`.
- Change: split by headings, accumulate `headingPath` ("A > B"); oversized sections fall to recursive char splitter (size 800 / overlap 120) preserving `headingPath`; never split mid-line; `tokenEstimate` (chars/4 heuristic).
- Acceptance: a nested-heading doc yields chunks with correct `headingPath`; no chunk exceeds size + overlap tolerance; no chunk breaks a line.
- Deps: B3.

**I3. Code chunker (R10)** `[core]`
- Files: `src/core/chunker.ts` (code path + ext dispatch), `test/chunker.code.test.ts`.
- Change: brace/indent heuristic top-level blocks; parent signature into `headingPath`; record `startLine`/`endLine`; dispatch by extension (`.md/.mdx/.txt` -> markdown; code exts -> code).
- Acceptance: a `.ts` file with two functions yields chunks whose `headingPath` contains the function signature and correct 1-based `startLine`/`endLine`.
- Deps: I2.

**I4. Ollama embedder + cache (R3)** `[core]`
- Files: `src/core/embedder.ts`, `test/embedder.test.ts` (mocked `fetch`).
- Change: `OllamaEmbeddings implements EmbeddingProvider`; `POST /api/embed` array `input`, batch 32, exponential retry (3), validates count + 768 dim; typed errors on connection refused / model missing; cache lookup/write in `embedding_cache` by `sha256(text)+model`.
- Acceptance: mocked run embeds only cache-miss texts, writes cache, returns vectors in input order; connection-refused -> `OllamaUnavailableError`; model-404 -> `ModelNotFoundError`.
- Deps: B4, B5.

**I5. Incremental ingest flow (R5)** `[core]`
- Files: `src/core/ingest.ts` (or `context.ts` ingest fn), `test/ingest.test.ts`.
- Change: orchestrate loaders -> chunker -> embedder -> store; per-file hash logic: `added`/`updated`/`unchanged`/`removed` (removed = sources gone from disk under ingested root); partial failures accumulate, don't abort; returns tally + elapsed.
- Acceptance: first run all `added`; unchanged rerun all `unchanged`; edited file -> `updated` (only it re-embedded); deleted file -> `removed`; returns `{added,updated,unchanged,removed,ms}`.
- Deps: I1, I3, I4.

**I6. CLI wiring + `ingest`/`stats`/`doctor`**
- Files: `src/cli/index.ts`, `src/cli/commands/ingest.ts`, `src/cli/commands/stats.ts`, `src/cli/commands/mcp.ts` (stub), `src/core/logger.ts`.
- Change: `commander` root; `ingest [path] [--collection] [--verbose]` (no path -> all config `roots`), progress bar on stderr; `stats` prints docs/chunks/db size/model/last-ingest; `doctor` validates Ollama reachable, model pulled, db perms, schema integrity. Logger routes to stderr.
- Acceptance: `rtk node dist/cli/index.js ingest ./test-docs` prints a tally; `stats` shows counts; `doctor` reports pass/fail per check with actionable messages.
- Deps: I5.

### Phase 2 — Retrieval

**R1. Dense + lexical search in store (R5, R6)** `[core]`
- Files: `src/core/store.ts` (`denseSearch`, `lexicalSearch`), `test/store.search.test.ts`.
- Change: `denseSearch(queryVec, k)` -> vec0 KNN ordered by distance; `lexicalSearch(query, k)` -> `chunks_fts MATCH` ordered by `bm25()`; both return `{ chunkId, rank, rawScore, chunk }`.
- Acceptance: seeded db returns expected ordering per leg; exact function-name query returns the right chunk via lexical leg.
- Deps: B4, I5 (for seeded data in tests).

**R2. RRF fusion + metadata filter (R6)** `[core]`
- Files: `src/core/retriever.ts`, `test/retriever.test.ts`.
- Change: `hybridSearch(query)`: embed query, `denseSearch(topK*3)` + `lexicalSearch(topK*3)`, fuse via `1/(rrfK + rank)`, apply metadata filter (equality + `$in`), normalize fused score, apply `minScore`, return top `topK` with per-leg debug data attached. Depends only on `Store` + `EmbeddingProvider` interfaces (R11).
- Acceptance: chunk present in both legs outranks single-leg chunks; `$in` and equality filters work; `minScore` on normalized score prunes low results; retriever imports no concrete impls.
- Deps: R1, I4.

**R3. Context builder** `[core]`
- Files: `src/core/context.ts`, `test/context.test.ts`.
- Change: `buildContext(results, tokenBudget)` -> ordered `<context>` block, `[n] source:lines — headingPath` headers, never split a chunk to fit; returns `{ text, sources: [{n,source,headingPath,lines,score}] }`; reports which chunks were dropped and why (for `--explain`).
- Acceptance: output matches Section 4.6 format; respects 4000-token budget without partial chunks; `sources` array is consistent with `text`.
- Deps: R2.

**R4. `query` command + `--explain`/`--json`**
- Files: `src/cli/commands/query.ts`.
- Change: `query "q" [--top-k] [--explain] [--json]`; default prints context + sources; `--explain` prints both legs' candidates with rank+raw score, RRF math per chunk, budget in/out decisions, and final context block; `--json` prints structured result.
- Acceptance: `query` returns cited results; `--explain` shows both legs + RRF + final context; `--json` is valid parseable JSON.
- Deps: R3.

### Phase 3 — MCP

**M1. MCP stdio server skeleton + stdout guard (R9)**
- Files: `src/mcp/server.ts`, `src/cli/commands/mcp.ts` (real).
- Change: create `McpServer` over `StdioServerTransport`; wire `ragkit mcp --collection`; ALL diagnostics to stderr; readable stderr error if startup fails; `ragkit mcp` runs standalone.
- Acceptance: `rtk node dist/cli/index.js mcp --collection pessoal` starts, emits nothing on stdout except MCP protocol frames, prints a legible error to stderr when Ollama/db missing.
- Deps: I6, R3.

**M2. Three MCP tools**
- Files: `src/mcp/tools.ts`.
- Change: register `search_context` (`{query, topK?, filter?}` -> ranked chunks with source/headingPath/lines/score, description written as *when to call*), `list_collections` (`{}` -> collections w/ doc+chunk counts), `get_document` (`{source}` -> full document content). Errors return readable messages, never stack traces. Hard cap 3 tools.
- Acceptance: MCP inspector/client can call each tool; `search_context` returns cited chunks; errors are human-readable strings; exactly 3 tools registered.
- Deps: M1, R2, B4.

**M3. Client registration docs**
- Files: `README.md` (MCP section), `docs/mcp-setup.md`.
- Change: document `claude mcp add --transport stdio ragkit --scope user -- npx -y ragkit mcp --collection pessoal`, the JSON `mcpServers` form, no-hot-reload caveat, and the `disconnected` debug tip.
- Acceptance: following the doc registers ragkit and it shows `connected` in `/mcp`.
- Deps: M2.

### Phase 4 — Polish

**P1. `--watch` mode (R10)**
- Files: `src/cli/commands/ingest.ts` (watch branch), `src/core/watch.ts`.
- Change: `chokidar` on ingested roots, 500ms debounce, reindex only changed file (or remove on unlink).
- Acceptance: editing a watched file reindexes just that file within ~1s; deleting removes it from the base.
- Deps: I5, I6.

**P2. `ragkit init` interactive**
- Files: `src/cli/commands/init.ts`.
- Change: interactive prompt framed as "which folders are part of your personal knowledge base?"; writes `ragkit.config.ts`; checks Ollama + model; creates the collection db. `--force` recreates on dimension mismatch (`DimensionMismatchError`).
- Acceptance: `ragkit init` produces a valid config, verifies Ollama, creates the collection; `--force` recreates cleanly.
- Deps: B4, I4, B5.

**P3. README + backlog + acceptance sweep**
- Files: `README.md`, `docs/BACKLOG.md`, `docs/HANDOFF.md`.
- Change: pipeline diagram, `--explain` walkthrough, offline guarantee, explicit backlog (pgvector, eval, HTTP, panel); run the full Section-9 acceptance checklist end-to-end; confirm `src/core` coverage ≥ 80%.
- Acceptance: every Section-9 acceptance box is checked or explicitly deferred with reason; `rtk npx vitest run --coverage` shows `src/core` ≥ 80%.
- Deps: all prior.

---

## 5. Impact Analysis
- **New tests:** every `[core]` unit ships tests; coverage gate enforced in P3. Use temp dirs (`os.tmpdir()`) for store/loader tests; mock `fetch` for embedder.
- **Native/build dependencies:** `better-sqlite3` (native) and `sqlite-vec` (loadable ext) are the primary Windows risk surface — front-loaded into B1 as a spike. Do not proceed past B1 if the vec spike fails.
- **Backward compatibility:** greenfield; the only forward-compat contract is the `Store`/`EmbeddingProvider` interface stability (R11), tested in R2 and P3.
- **Security/failure modes:** offline-only (no network except localhost Ollama); typed actionable errors; partial-batch ingest failures are non-fatal; MCP stdout purity is protocol-critical (R9).
- **Performance:** incremental hash-skip must make a 200-file unchanged reingest < 2s (Section 9); embedding cache avoids re-embedding unchanged chunks.

## 6. Open Questions
1. **`minScore` semantics (R6):** default `0.3` is incompatible with raw RRF magnitudes. Spec assumes normalized fused score. Confirm with user, else default retrieval `minScore` behavior to normalized. (Proceeding with normalized.)
2. **Ollama endpoint (R3):** confirm the target Ollama version exposes `/api/embed` with array input. If users may run older Ollama, a `/api/embeddings` fallback becomes a follow-up unit. (MVP requires new endpoint.)
3. **Embedding storage format in vec0 (R5):** exact bind form (`vec_f32(json())` vs raw BLOB) depends on the installed `sqlite-vec` build — pin during B1/B2.
4. **`get_document` source resolution:** `source` is stored root-relative with forward slashes; confirm the tool matches on that exact stored key vs. an absolute path.

---

## Next Unit to Delegate

> **Spec:** `docs/specs/ragkit-mvp.md`
> **Unit:** B0 — Package scaffold & tooling
> **Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.ragkitignore`, `src/index.ts`
> **Change:** Create the ESM `ragkit` package scaffold with declared deps/devDeps and scripts per Unit B0.
> **Acceptance:** `npm install`, `npx tsc --noEmit`, and `npx vitest run` all succeed on the empty tree (PowerShell, Windows).
> **Constraints:** ESM (`"type":"module"`), Node ≥ 20, single package, no code logic yet. Then proceed to **B1 (the sqlite-vec spike) before anything else** — halt and report if it fails.

# ragkit Review

**Status:** Draft
**Date:** 2026-07-20
**Scope:** CLI, config loading, Ollama wiring, doctor/init flows, and brand direction for a portfolio site

## Findings

### Blocker: the Ollama env fallback is effectively dead code
The embedder still reads `process.env.OLLAMA_BASE_URL`, but every CLI entrypoint passes a concrete `baseUrl` from config, and the config schema also defaults that value to `http://localhost:11434`. That means the env var never changes behavior in the normal CLI path, so users cannot redirect ragkit to a non-default local Ollama endpoint without editing the config file.

Relevant files:
- [src/core/embedder.ts](../../src/core/embedder.ts#L89)
- [src/cli/commands/ingest.ts](../../src/cli/commands/ingest.ts#L45)
- [src/cli/commands/query.ts](../../src/cli/commands/query.ts#L145)
- [src/cli/commands/mcp.ts](../../src/cli/commands/mcp.ts#L39)

Fix direction:
- Choose a single source of truth for Ollama base URL.
- Either let config omit `baseUrl` so the env fallback can work, or resolve the URL once in config loading and thread the final value through all adapters.
- Update init/docs to match the chosen contract.

### Issue: `doctor` mutates state instead of checking it
`doctor` calls `openStore`, which opens the SQLite database and runs migration logic. That means a health check can create or upgrade the database as a side effect, which hides missing-file and initialization problems instead of reporting them. A doctor command should be diagnostic only.

Relevant file:
- [src/cli/commands/doctor.ts](../../src/cli/commands/doctor.ts#L85)

Fix direction:
- Use a read-only existence/integrity check for doctor.
- Avoid migration in the health check path.
- Report a clear failure if the database is missing or schema is not what the app expects.

### Issue: `init` writes config before it knows the setup succeeded
`runInit` writes `ragkit.config.ts` before it checks Ollama and before it creates the collection database. If later steps fail, the user is left with a config file that looks successful even though initialization did not complete.

Relevant file:
- [src/cli/commands/init.ts](../../src/cli/commands/init.ts#L213)

Fix direction:
- Write the config last, or clean it up if DB creation fails.
- Keep the initialization flow atomic from the user’s perspective.
- If Ollama is unreachable, make it obvious whether init is only warning or actually succeeding.

## Architecture Notes

The codebase is generally cleanly layered and the direction is good: CLI commands orchestrate, core modules own retrieval and storage logic, and the MCP layer stays separate. The main thing to tighten is contract consistency at the boundaries:
- config should be the single authority for runtime settings,
- health checks should stay side-effect free,
- init should not leave half-finished state behind.

## Logo Direction

If you are making a portfolio site, I would frame the brand as **local-first retrieval with a precise, technical feel** rather than a generic AI logo.

Recommended logo concept:
- Symbol: a compact rounded cube or monogram built from a lowercase `r` and a search-node motif.
- Meaning: the cube suggests a local knowledge store; the internal node or spark suggests retrieval.
- Style: geometric, minimal, slightly engineered, not playful.
- Tone: trustworthy, offline, sharp, developer-oriented.

Suggested palette:
- Primary: graphite / near-black
- Accent: cyan or teal
- Neutral: warm off-white

Suggested wordmark treatment:
- Lowercase `ragkit`
- Tight spacing
- Simple sans-serif with a technical edge
- Use the icon alone for favicon and social avatar

## Implementer Handoff

> **Spec:** `docs/reviews/ragkit-review.md`
> **Unit:** 1 — Normalize Ollama configuration and remove dead env fallback
> **Files:** `src/core/embedder.ts`, `src/cli/commands/ingest.ts`, `src/cli/commands/query.ts`, `src/cli/commands/mcp.ts`, `src/config.ts`, `src/cli/commands/init.ts`
> **Change:** Make Ollama base URL resolution consistent so the CLI honors one clear source of truth instead of ignoring `OLLAMA_BASE_URL`.
> **Acceptance:** A non-default Ollama base URL can be selected without editing every call site, and the chosen behavior is documented.
> **Constraints:** Keep the CLI boundary thin; do not collapse config, embedder, and retriever layers into one adapter.

> **Unit:** 2 — Make `doctor` read-only
> **Files:** `src/cli/commands/doctor.ts`
> **Change:** Remove database migration/creation side effects from health checks.
> **Acceptance:** Running `doctor` on a missing database reports failure instead of creating a new database.
> **Constraints:** Preserve actionable output and stderr-only diagnostics.

> **Unit:** 3 — Make init atomic from the user’s perspective
> **Files:** `src/cli/commands/init.ts`
> **Change:** Ensure config is not left behind when initialization fails partway through.
> **Acceptance:** A failed init does not leave a misleading partial setup behind.
> **Constraints:** Keep the interactive prompts and current defaults intact.

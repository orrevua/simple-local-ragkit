# Learning with ragkit

ragkit is small enough (~3.5k lines of TypeScript) to read end to end. This
guide follows a query through the pipeline: which file teaches which RAG
concept, and what to try at each stop. Then come exercises to extend it.

## Setup for studying

```bash
npm install && npm run build
cd examples/fastapi-docs && ./fetch-docs.sh && npx ragkit ingest
```

The example uses the offline `hash` embedder, so everything runs without
Ollama. Switch to `ollama` once you want real semantic search.

## Guided tour

| # | Concept | Read | Try |
| --- | --- | --- | --- |
| 1 | Loading & incremental ingestion | `src/core/loaders.ts`, `src/core/ingest.ts` | Run `ragkit ingest` twice. The second run reports everything `unchanged`, because documents are skipped by content hash. Edit one file and ingest again. |
| 2 | Chunking | `src/core/chunker.ts` | `ragkit chunks docs/cors.md --size 300` and then `--size 1200`. Watch the boundaries move. Notice chunk `#0` is only a heading. |
| 3 | Embeddings | `src/core/embedder.ts`, `src/core/providers.ts` | Read `hashEmbed`: it is the whole "model". Why do "car" and "automobile" get unrelated vectors? |
| 4 | Storage: vectors + full-text in one DB | `src/core/store.ts` (schema in `migrate`) | Find the FTS5 triggers that keep `chunks_fts` in sync. Read `toFtsQuery` to see why raw questions break FTS5. |
| 5 | Hybrid retrieval & RRF | `src/core/retriever.ts` | `ragkit query "add CORS" --explain`. Recompute one fused score by hand: `1/(60+denseRank) + 1/(60+lexicalRank)`. |
| 6 | Reranking (two-stage retrieval) | `src/core/reranker.ts` | `--strategy hybrid` vs `--strategy hybrid-rerank --explain`. Which chunk moved, and why? |
| 7 | Context building & token budgets | `src/core/context.ts` | Lower `contextTokens` in the config to 500 and look at the `dropped` list in `--explain`. |
| 8 | Evaluation | `src/core/eval.ts` | Compute MRR and nDCG for one case by hand from `--json` output, then `ragkit eval golden.json --compare`. |
| 9 | Serving to agents | `src/mcp/tools.ts`, `src/http/server.ts` | Read the `search_context` tool description: it's written for a model, not a human. Hook ragkit into Claude Code with `docs/mcp-setup.md`. |

## Improve it yourself

Each exercise names where to start and how you'll know it worked. Measure
retrieval changes with `ragkit eval examples/fastapi-docs/golden.json --compare`
before and after.

1. **Drop heading-only chunks** *(easy)*: `ragkit chunks` shows chunks that
   contain only a heading. Merge them into the next section in
   `markdownChunker`. Success: no chunk under ~10 tokens, eval does not regress.
2. **Strip mkdocs anchors** *(easy)*: heading paths carry `{ #cors-... }`
   noise. Clean it in the chunker and add a test.
3. **Embedding cache keyed by model** *(easy)*: `embedding_cache` uses
   `text_hash` alone as the primary key, so alternating between two models keeps
   overwriting the cache. Make the key `(text_hash, model)` with a schema
   migration (bump `SCHEMA_VERSION`).
4. **Weighted RRF** *(medium)*: add `retrieval.denseWeight` /
   `lexicalWeight`. With the hash embedder, does down-weighting dense make
   hybrid beat plain BM25?
5. **Filter inside the query, not after** *(medium)*: metadata filters run
   after fusion (`matchesFilter`), so a selective filter can leave fewer than
   `topK` results. Push the filter into the SQL of both legs.
6. **Cross-encoder reranker** *(medium)*: implement `Reranker` with a real
   model (for example `bge-reranker` behind a small HTTP service, or an LLM
   asked to score relevance 0–1 through Ollama). Compare it with
   `term-coverage`.
7. **Query rewriting / multi-query** *(medium)*: ask a local LLM for 3
   paraphrases, retrieve for each, and fuse with RRF. Add it as a new strategy
   in `RETRIEVAL_STRATEGIES`.
8. **Parent-document retrieval** *(medium)*: retrieve small chunks, but return
   their whole section (or neighbor chunks) as context. Add a preset.
9. **`ragkit ask`** *(medium)*: generate an answer with citations from the
   context block using a local model. Then extend `eval` with answer metrics
   (faithfulness, correctness). The P1 project (rag-evals-pgvector) has an
   LLM-as-judge you can port.
10. **A pgvector `Store`** *(hard)*: implement the `Store` interface on
    Postgres + pgvector + `tsvector`, selectable in config. The retriever and
    eval code shouldn't change at all. That is the payoff of the interfaces.
11. **Harder golden set** *(easy, high value)*: add multi-hop and zero-overlap
    paraphrase questions to `examples/fastapi-docs/golden.json`. A golden set
    that every strategy aces can't tell them apart.
12. **Real-model numbers** *(easy)*: rerun the comparison with Ollama and
    `text-embedding-3-small`, and put the three tables side by side in a blog
    post for orrevua.dev.

## References

- [Reciprocal Rank Fusion (Cormack et al., 2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [SQLite FTS5](https://www.sqlite.org/fts5.html) and [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [Model Context Protocol docs](https://modelcontextprotocol.io)
- [RAGAS metrics](https://docs.ragas.io/) for answer-level evaluation

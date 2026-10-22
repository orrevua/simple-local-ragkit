# Example: comparing retrieval strategies on the FastAPI tutorial

A ready-made playground for `ragkit eval --compare`: a public corpus (the
[FastAPI tutorial docs](https://github.com/fastapi/fastapi/tree/master/docs/en/docs/tutorial),
MIT licensed, pinned commit) and a 25-question golden set written against it.
Most questions are deliberately phrased **without** the page's own title words
("let a frontend on another origin call my API" instead of "CORS"), which is
where lexical search struggles and semantic embeddings should help.

```bash
cd examples/fastapi-docs
./fetch-docs.sh                    # downloads ~440 KB of markdown
npx ragkit ingest
npx ragkit eval golden.json --compare --top-k 5
```

## Baseline results (offline hash embedder)

Produced in this repo with `embeddings.provider: "hash"`. No model was involved,
so the "dense" leg is just lexical feature hashing:

| strategy | what it does | hit | MRR | nDCG | precision | recall |
| --- | --- | --- | --- | --- | --- | --- |
| dense | vector similarity only | 0.680 | 0.333 | 0.404 | 0.232 | 0.640 |
| lexical | BM25 full-text only | 1.000 | 0.863 | 0.889 | 0.568 | 1.000 |
| hybrid | dense + BM25 fused with Reciprocal Rank Fusion | 0.920 | 0.750 | 0.779 | 0.416 | 0.900 |
| hybrid-rerank | hybrid, then a reranker reorders the fused pool | 0.960 | 0.833 | 0.851 | 0.512 | 0.940 |

**How to read it:** fusion is only as good as its legs. A weak dense leg
(hash vectors carry no meaning) drags hybrid *below* plain BM25, and the
reranker wins most of that back. RRF has no idea which leg to trust, so it
gives both equal weight.

## Your turn

1. Switch to `provider: "ollama"`, run `ragkit init --force && ragkit ingest`,
   and re-run the comparison. Does dense overtake lexical? Does hybrid now beat
   both legs? Record the table here.
2. Add 10 harder questions: multi-hop ("protect a router with OAuth2 and test
   it"), and paraphrases with zero word overlap.
3. Try `--top-k 3` vs `--top-k 10`. Precision and recall move in opposite
   directions. Why?

# RAG-Kit — Spec de Arquitetura (v2)

> Revisão da v1 incorporando o parecer de arquitetura. As mudanças de fundo
> estão marcadas com **[v2]** e justificadas na seção 13 (changelog de decisões).
> Toolkit em Python para adicionar RAG a qualquer modelo com curva de aprendizado
> baixa, construído com a camada de engenharia que separa "pluguei uma API" de
> "entendo RAG em produção". Uso próprio + peça de portfólio.

## 0. Enquadramento **[v2]**

Este é um **projeto novo em Python**, não uma evolução do `ragkit` (TypeScript /
SQLite / Ollama / MCP) que vive neste repositório. A decisão de reescrever em
Python é deliberada (skill de portfólio + ecossistema de eval/ML). Como
consequência, **portamos explicitamente** as ideias já provadas no ragkit-TS que
o resto deste doc precisa:

- **Retrieval híbrido (vetor + BM25 + fusão RRF)** — não começar só com vetor.
- **Explain mode** — expor legs denso/lexical, ranks, scores e fusão por query.

O que é genuinamente novo (e é o diferencial): o **eval harness de retrieval**.

## 1. Objetivo e proposta de valor

Um dev quer adicionar RAG a um modelo e hoje costura na mão: loader, chunking,
embeddings, vector store, retrieval, reranking, montagem de prompt. O RAG-Kit
entrega isso como biblioteca instalável + serviço de referência + playground
visual, com providers plugáveis e — o diferencial — um harness de avaliação de
retrieval embutido.

Tese do projeto: **"RAG bom é retrieval bom, não prompt mágico. Construí a
ferramenta que mede isso."**

## 2. O que torna isto sênior

Cada item deve estar visível no código **e** documentado:

- **Eval harness de retrieval** — métricas objetivas (Hit Rate, MRR, nDCG,
  context precision/recall) sobre um golden dataset **ancorado na fonte**
  (ver §5.5).
- **Arquitetura hexagonal** — o domínio não conhece provider concreto. Trocar
  provider = adapter, não reescrita.
- **Benchmark de estratégias de retrieval** — as 4 estratégias de chunking **e**
  vetor-puro vs. híbrido, com números, contra o mesmo eval set. **[v2]**
- **Observabilidade da camada RAG** — cada query rastreável: chunks, score,
  tokens, latência, custo.
- **Guardrails de grounding** — citação estrutural por ID de chunk (ver §5.4).
- **Caching** — cache de embeddings; cache semântico como experimento medido
  (ver §7).

## 3. Arquitetura

Três camadas, hexagonal no núcleo:

```
┌─────────────────────────────────────────────────────────────┐
│  Playground UI (Next.js)   — demo visual: query, chunks,     │
│                              scores, eval dashboard           │
├─────────────────────────────────────────────────────────────┤
│  rag_service (FastAPI)     — REST: /ingest /query /eval      │
├─────────────────────────────────────────────────────────────┤
│  rag_kit (biblioteca Python)                                 │
│                                                              │
│   DOMÍNIO (puro, sem I/O)                                     │
│    ├─ chunking/     estratégias de split                     │
│    ├─ retrieval/    orquestração + fusão híbrida + rerank    │
│    ├─ evaluation/   métricas e harness                       │
│    └─ pipeline/     ingestão e query como use cases          │
│                                                              │
│   PORTAS (interfaces)                                        │
│    ├─ EmbeddingProvider  ├─ VectorStore                      │
│    ├─ LexicalStore       ├─ LLMProvider                      │
│    └─ DocumentLoader                                         │
│                                                              │
│   ADAPTERS (I/O concreto)                                    │
│    ├─ embeddings: sentence-transformers (default) | gemini   │
│    ├─ vectorstore: sqlite-vec (default) | pgvector           │
│    ├─ lexical:     sqlite-fts5 (default) | (pg tsvector)     │
│    ├─ llm: ollama (default) | gemini                         │
│    └─ loaders: pdf | markdown | html | txt                  │
└─────────────────────────────────────────────────────────────┘
```

Regra de ouro: **nada em `domain/` importa um SDK de provider**. Se importar, a
arquitetura quebrou.

**[v2] Matriz de adapters enxuta:** no MVP, cada porta tem **default + 1
alternativa** — o suficiente para *provar* a troca por adapter. O resto é
roadmap, não manutenção.

## 4. Stack

- **Linguagem:** Python 3.12.
- **Serviço:** FastAPI + Pydantic v2.
- **Defaults locais (offline-first) [v2]:** embeddings `sentence-transformers`,
  LLM `Ollama`, vector store `sqlite-vec`, lexical `FTS5`. Roda 100% offline,
  sem rede, sem chave — coerente com o discurso de "roda de graça".
- **Adapters cloud (opt-in):** Gemini (`text-embedding-004` / geração) e
  pgvector (Supabase free tier).
- **Observabilidade:** OpenTelemetry (traces) + `structlog`.
- **Playground:** Next.js 15 + Tailwind + shadcn/ui.
- **Testes:** pytest; eval harness como suíte separada.

## 5. Componentes em detalhe

### 5.1 Chunking (o benchmark)

Interface `ChunkingStrategy.split(document) -> list[Chunk]`. Quatro
implementações:

- **FixedSizeChunker** — tamanho fixo + overlap (baseline).
- **RecursiveChunker** — separadores hierárquicos (parágrafo → frase).
- **SentenceWindowChunker** — chunk = frase, recupera janela de vizinhas.
- **SemanticChunker** — quebra onde a similaridade entre frases adjacentes cai.

Cada `Chunk` guarda `text`, `metadata` (fonte, posição) e — **crítico para o
eval [v2]** — `source_span` (`doc_id`, `char_start`, `char_end`) do documento
original, além de `parent_id` (para a janela).

### 5.2 Retrieval **[v2] híbrido desde o início**

- Busca vetorial top-k via `VectorStore`.
- Busca lexical (BM25/FTS5) via `LexicalStore`.
- **Fusão RRF** dos dois rankings (portado do ragkit-TS).
- **Reranking** (cross-encoder local ou reordenação por score) — plugável e
  **medido como eixo do eval**, não como extra opcional.
- Retorna `RetrievalResult` com chunks **e** scores por leg (denso, lexical,
  fundido). A UI e o explain mode sempre mostram o score.

### 5.3 Pipeline de ingestão (assíncrona) **[v2]**

`load → chunk → embed (batch) → upsert`. **Idempotente por hash do conteúdo**
(não re-embeda documento já indexado). Suporta:

- **Atualização incremental** (re-chunk só do que mudou).
- **Remoção** — documento sumiu da fonte ⇒ seus chunks são pruned (evita órfãos).
- **Execução em background** — endpoint `/ingest` enfileira via FastAPI
  `BackgroundTasks` (MVP) com caminho de evolução para worker dedicado; retorna
  `job_id` e status consultável, não bloqueia a request.

### 5.4 Geração com grounding **[v2] citação estrutural**

Monta prompt com os chunks numerados e **exige citação por ID** (`[c3]`). O
pós-processamento **valida os IDs citados contra os chunks recuperados** (não
match textual, que quebra com paráfrase). Resposta sem nenhum ID válido ⇒
marcada `ungrounded`. Faithfulness por LLM-as-judge é um check adicional
opcional (§5.5), fora do gate de CI.

### 5.5 Eval harness — o coração do projeto **[v2] ancorado na fonte**

**Golden dataset:** lista de
`(pergunta, relevant_spans, resposta_esperada?)`, onde `relevant_spans` são
**trechos do documento-fonte** (`doc_id`, `char_start`, `char_end`) — **não**
IDs de chunk.

Motivo (falha corrigida da v1): chunk IDs dependem do chunker. Um label preso a
chunk ID só vale para o chunker que o gerou, impossibilitando comparar as 4
estratégias contra o mesmo golden set. Ancorando na fonte, um chunk conta como
relevante quando **sobrepõe** um `relevant_span` — e as métricas passam a ser
comparáveis entre chunkers.

**Métricas de retrieval (determinísticas, sem LLM, rodam no CI):**

- **Hit Rate @k** — algum chunk relevante apareceu no top-k?
- **MRR** — quão no topo veio o primeiro relevante?
- **nDCG @k** — qualidade do ranking (labels binários; limitação documentada —
  para relevância graduada, ver roadmap).
- **Context Precision / Recall** — proporção recuperada que é relevante / de
  relevante que foi recuperada.

**Métricas de geração (opcionais, LLM-as-judge, FORA do CI):** faithfulness e
answer relevance. Não determinísticas e dependentes de rede ⇒ rodam sob demanda,
não gatilham o gate.

**Saída:** relatório (JSON + tabela markdown) comparando configurações
(chunker × vetor/híbrido × rerank on/off), com o **hash da config** para
reprodutibilidade. É o gráfico do post: *"chunking semântico + híbrido ganhou
X% de MRR sobre fixed-size vetor-puro no meu eval set de N perguntas."*

## 6. Observabilidade

Cada `/query` gera um trace com spans:
`embed_query → vector_search → lexical_search → fuse → rerank → generate`.
Atributos: `k`, scores por leg, nº de tokens, latência por etapa, custo
estimado. Local: console/Jaeger. Permite responder "por que essa resposta ficou
ruim?" olhando o trace.

## 7. Caching **[v2] semantic cache como experimento medido**

- **Embedding cache** — chave = `hash(texto + modelo)`. Evita re-embedar.
- **Semantic cache** — se uma query nova tem `cosine > limiar` a uma já
  respondida, **pode** devolver do cache. Tratado como experimento: expõe
  **hit rate E taxa de resposta incorreta** (proximidade de embedding ≠
  equivalência de intenção). **Desligado por padrão**; ligado com limiar
  conservador e sob observação.

## 8. Hosting free-tier

- **Vector store + DB (cloud opt-in):** Supabase (pgvector) free tier.
- **Serviço FastAPI:** Fly.io ou Render free tier.
- **Playground:** Vercel.
- **Default de desenvolvimento e demo:** 100% local (sqlite-vec + FTS5 + Ollama
  + sentence-transformers), sem rede, sem custo. Documentar no README que o
  projeto roda de graça — consciência de custo.

## 9. Estrutura de pastas

```
rag-kit/
├─ rag_kit/
│  ├─ domain/
│  │  ├─ chunking/     (strategies + Chunk c/ source_span)
│  │  ├─ retrieval/    (retriever, fusão RRF, reranker, RetrievalResult)
│  │  ├─ evaluation/   (metrics, harness, golden dataset loader)
│  │  └─ pipeline/     (IngestUseCase, QueryUseCase)
│  ├─ ports/           (EmbeddingProvider, VectorStore, LexicalStore,
│  │                    LLMProvider, DocumentLoader)
│  └─ adapters/
│     ├─ embeddings/   ├─ vectorstore/  ├─ lexical/  ├─ llm/  └─ loaders/
├─ rag_service/        (FastAPI app)
├─ playground/         (Next.js)
├─ evals/              (golden datasets + resultados versionados por config-hash)
├─ docs/
│  ├─ adr/             (decisões arquiteturais)
│  └─ benchmarks/      (relatórios de retrieval)
├─ docker-compose.yml  (postgres+pgvector, jaeger, ollama)
└─ README.md
```

## 10. Roadmap em fases **[v2]**

- **Fase 0 (MVP):** loaders md/txt, FixedSizeChunker, **stack local default**
  (sentence-transformers + sqlite-vec + FTS5 + Ollama), retrieval **híbrido**,
  QueryUseCase, `/ingest` e `/query`. Roda ponta a ponta offline.
- **Fase 1:** eval harness + golden dataset ancorado na fonte + as 4 estratégias
  de chunking + eixo vetor/híbrido/rerank + relatório de benchmark. **← vira
  portfólio aqui.**
- **Fase 2:** observabilidade (OTel), embedding cache, guardrail de grounding
  estrutural.
- **Fase 3:** semantic cache (medido), adapters cloud (Gemini, pgvector),
  reranking avançado, playground visual, deploy free-tier.

Não pular a Fase 1 pra correr pra Fase 3. O eval é o diferencial.

## 11. O que documentar (multiplicador de portfólio)

- README com diagrama da arquitetura e a tabela de benchmark no topo.
- ADRs em `docs/adr/`: "Por que hexagonal", "Por que defaults locais e cloud
  opt-in", "Por que medir retrieval separado da geração", "Por que ancorar o
  golden set na fonte e não em chunk IDs".
- 1 post de blog: "Como eu meço qualidade de RAG" com os gráficos do benchmark.

## 12. Checklist de senioridade

- [ ] `domain/` não importa nenhum SDK de provider.
- [ ] Trocar de vector store = escrever 1 adapter, zero mudança no domínio
      (provado com sqlite-vec **e** pgvector).
- [ ] Golden dataset versionado, **ancorado na fonte**, e o eval de retrieval
      (determinístico) roda no CI.
- [ ] README abre com diagrama + números de benchmark (incl. vetor vs. híbrido).
- [ ] Todo retrieval expõe scores por leg; toda query é rastreável.
- [ ] Pelo menos 1 ADR explicando um trade-off real.

## 13. Changelog de decisões (v1 → v2)

1. **Enquadramento explícito** como projeto novo em Python, portando híbrido +
   explain do ragkit-TS.
2. **Golden dataset ancorado em spans de fonte**, não chunk IDs — corrige a
   impossibilidade de comparar chunkers.
3. **Retrieval híbrido (RRF) desde a Fase 0** e como eixo do benchmark; rerank
   também medido, não "opcional".
4. **Defaults locais / cloud opt-in** — coerência com o discurso offline e
   CI determinístico (só métricas de retrieval no gate; LLM-as-judge fora).
5. **Semantic cache e grounding** reclassificados como experimentos medidos com
   definição rigorosa (citação estrutural por ID; cache com taxa de erro exposta).
6. **Matriz de adapters enxuta** (default + 1 por porta no MVP).
7. **Ingestão** ganha remoção/prune e execução em background.

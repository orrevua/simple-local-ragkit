# RAGKit — Especificação Técnica (v2, escopo pessoal)

> Camada de contexto local para as minhas IAs. Indexa docs e código, roda 100% offline, e expõe a base como ferramenta MCP para qualquer agente consultar.

**Versão:** 2.0 (MVP pessoal)
**Autor:** França (orrevua)
**Licença:** MIT

---

## 1. Objetivo

Um único comando indexa documentos e código; um servidor MCP expõe essa base para agentes (Claude Code, Claude Desktop, etc.); um CLI permite consultar e depurar o retrieval no terminal.

### 1.1 Posicionamento: base transversal, não indexação do repo atual

O Claude Code já lê arquivos, busca no codebase e roda comandos no projeto aberto — indexar o repositório atual é em grande parte redundante e a busca nativa tende a ganhar.

O valor do RAGKit está no que o agente **não** alcança na sessão: specs e decisões arquiteturais de projetos anteriores, notas pessoais, documentação de repos que não estão abertos, aprendizados acumulados. Portanto:

- A collection default (`pessoal`) é **transversal**, apontando para diretórios de notas/specs/docs fora do projeto atual.
- Indexar um repositório inteiro é caso de uso secundário, suportado mas não incentivado.
- `ragkit init` deve deixar isso explícito na pergunta interativa: "quais pastas fazem parte da sua base de conhecimento pessoal?" — e não "qual projeto indexar?".

**Não-objetivos (ficam no backlog do README):** API HTTP, painel web, fila de jobs, pgvector/Qdrant, reranking, suíte de eval, `eject`, múltiplos providers de embedding, loaders de PDF/docx.

### Princípios
1. **Local-first absoluto.** Sem API key, sem cartão, sem rede. SQLite + Ollama.
2. **Incremental por padrão.** Reindexar um repo que mudou deve custar segundos, não minutos.
3. **Transparente.** Todo retrieval pode ser inspecionado (`--explain`).
4. **Abstrações preservadas.** Interfaces de store/embedding/LLM existem mesmo com uma implementação cada — é o que permite adicionar pgvector depois sem refatorar.

---

## 2. Stack

- **Linguagem:** TypeScript, Node.js ≥ 20. Pacote único (`ragkit`), sem monorepo.
- **Banco:** SQLite via `better-sqlite3` + extensão `sqlite-vec` (busca vetorial) + FTS5 (busca por palavra-chave).
- **Embeddings:** Ollama (`nomic-embed-text`, 768 dim) via HTTP local.
- **MCP:** `@modelcontextprotocol/sdk` (transporte stdio).
- **CLI:** `commander` + `picocolors`.
- **Validação:** `zod`. **Testes:** `vitest`.

Estrutura:
```
src/
  core/      types.ts  loaders.ts  chunker.ts  embedder.ts  store.ts  retriever.ts  context.ts
  cli/       index.ts  commands/{init,ingest,query,stats,mcp}.ts
  mcp/       server.ts  tools.ts
  config.ts
```

---

## 3. Modelo de dados

```ts
type Document = {
  id: string;            // uuid
  collection: string;
  source: string;        // caminho relativo ou URL
  contentHash: string;   // sha256 do conteúdo bruto
  metadata: Record<string, unknown>;
  mtime: number;
  createdAt: number;
};

type Chunk = {
  id: string;
  documentId: string;
  idx: number;
  text: string;
  headingPath?: string;  // "Instalação > Requisitos" ou "class Foo > method bar"
  startLine?: number;    // para arquivos de código
  endLine?: number;
  tokenEstimate: number;
};
```

Schema SQLite:
```sql
CREATE TABLE collections (name TEXT PRIMARY KEY, dimensions INTEGER, embed_model TEXT, created_at INTEGER);
CREATE TABLE documents (id TEXT PRIMARY KEY, collection TEXT, source TEXT, content_hash TEXT, metadata TEXT, mtime INTEGER, created_at INTEGER);
CREATE UNIQUE INDEX idx_doc_source ON documents(collection, source);
CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER, text TEXT, heading_path TEXT, start_line INTEGER, end_line INTEGER, token_estimate INTEGER, metadata TEXT);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid');
CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768]);
CREATE TABLE embedding_cache (text_hash TEXT PRIMARY KEY, model TEXT, embedding BLOB, created_at INTEGER);
```
Banco default em `~/.ragkit/<collection>.db`; sobrescrevível por config/flag.

---

## 4. Pipeline

### 4.1 Loaders
MVP: `.md`, `.mdx`, `.txt`, e código-fonte (`.ts`, `.tsx`, `.js`, `.py`, `.sql`, `.json`, `.yaml`).
- Entrada aceita: caminho de pasta (walk recursivo), arquivo único ou glob.
- Respeita `.gitignore` + `.ragkitignore`; ignora por padrão `node_modules`, `.git`, `dist`, `build`, `.next`, arquivos > 1 MB e binários.
- Metadata automática: `{ ext, relPath, dir, mtime }`.

### 4.2 Chunking
Duas estratégias, escolhidas automaticamente pela extensão:
- **`markdown`** (docs): quebra por headings, mantém `headingPath` acumulado. Seções maiores que o limite caem no splitter recursivo preservando o `headingPath`.
- **`code`** (código): quebra em blocos de nível superior por heurística de indentação/chaves (sem parser AST no MVP), preservando a assinatura do bloco pai em `headingPath` e registrando `startLine`/`endLine`.
- Limite default 800 caracteres, overlap 120. Nunca quebra no meio de uma linha.

### 4.3 Embeddings
```ts
interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```
Implementação única: `OllamaEmbeddings` — POST `${OLLAMA_BASE_URL}/api/embed`, batch de 32, retry exponencial (3 tentativas), erro claro e acionável se o Ollama não estiver rodando ou o modelo não estiver puxado (`ollama pull nomic-embed-text`).
Cache obrigatório: antes de embedar, consulta `embedding_cache` por `sha256(text)+model`.

### 4.4 Ingestão incremental
Para cada arquivo encontrado:
1. Calcula `contentHash`. Se existe documento com mesmo `source` e mesmo hash → **skip** (conta como `unchanged`).
2. Se existe com hash diferente → transação: deleta chunks antigos, insere novos (`updated`).
3. Se não existe → insere (`added`).
4. Documentos cujo `source` sumiu do disco e estavam sob a raiz ingerida → deletados (`removed`).

Saída: `12 added, 3 updated, 148 unchanged, 1 removed — 4.2s`.

### 4.5 Retrieval híbrido
1. Busca densa: `chunks_vec` por distância cosseno, `topK * 3` candidatos.
2. Busca lexical: `chunks_fts` (BM25), `topK * 3` candidatos.
3. Fusão por **Reciprocal Rank Fusion**: `score = Σ 1 / (60 + rank_i)`.
4. Filtro de metadata (igualdade e `$in`), corte por `minScore`, retorna `topK` (default 8).

Justificativa da hibridez: buscas por nome exato de função, variável de ambiente ou chave de config falham em retrieval puramente denso.

### 4.6 Context builder
Monta bloco com orçamento de tokens (default 4000), por ordem de score, sem cortar chunk pela metade:
```
<context>
[1] src/core/store.ts:41-78 — class SqliteStore > upsert
...texto...

[2] docs/setup.md § Instalação > Requisitos
...texto...
</context>
```
Retorna `{ text, sources: [{ n, source, headingPath, lines, score }] }`.

---

## 5. CLI

```bash
ragkit init                       # cria ragkit.config.ts, checa Ollama, cria a collection
ragkit ingest [path] [--collection c] [--watch]   # sem path: reindexa todos os `roots` do config
ragkit query "pergunta" [--top-k 8] [--explain] [--json]
ragkit stats                      # docs, chunks, tamanho do db, modelo, última ingestão
ragkit mcp                        # sobe o servidor MCP em stdio
ragkit doctor                     # valida Ollama, modelo, permissões do db, integridade do schema
```

### `--explain` (feature central)
Imprime, além dos resultados:
- os candidatos de cada perna (densa e lexical) com posição e score bruto;
- o cálculo do RRF por chunk;
- quais chunks entraram no orçamento de tokens e quais foram descartados, e por quê;
- o bloco de contexto final exatamente como seria entregue ao modelo.

### `--watch`
`chokidar` observando a raiz ingerida, com debounce de 500 ms, reindexando só o arquivo alterado.

---

## 6. Servidor MCP (`ragkit mcp`)

Transporte **stdio** (servidor local, roda como processo filho do cliente).

### 6.1 Registro no Claude Code

```bash
claude mcp add --transport stdio ragkit --scope user -- npx -y ragkit mcp --collection pessoal
```

- `--` separa as flags do próprio CLI do Claude do comando repassado ao servidor.
- Escopos: `local` (default, privado e restrito ao projeto atual), `project` (compartilhado via `.mcp.json` versionado), `user` (disponível em todos os projetos da máquina). **Para base pessoal transversal, usar `user`.**
- Dentro da sessão, `/mcp` lista e gerencia os servidores conectados.

### 6.2 Registro em clientes que usam JSON

```json
{ "mcpServers": { "ragkit": { "command": "npx", "args": ["-y", "ragkit", "mcp", "--collection", "pessoal"] } } }
```

### 6.3 Restrições de projeto derivadas do MCP

1. **Descrição das tools é código, não documentação.** É o sinal primário que o agente usa para decidir qual ferramenta chamar. Escrever como instrução de *quando* acionar, e iterar testando com o agente real.
2. **Orçamento de contexto.** Cada servidor conectado consome janela de contexto em toda sessão (nomes de tools + instruções do servidor). Teto rígido de **3 tools**; qualquer nova capacidade entra como parâmetro de uma tool existente, não como tool nova.
3. **Config não recarrega a quente.** Mudança de configuração exige reiniciar o cliente ou reconectar via `/mcp`. Documentar no README, porque afeta o loop de desenvolvimento.
4. **Debug.** Se o servidor aparecer como `disconnected`, rodar o comando bruto no terminal expõe o erro real mais rápido que ler logs. Por isso: `ragkit mcp` deve funcionar isoladamente e imprimir erro legível em stderr.
5. **stdout é sagrado.** Nenhum log, banner ou barra de progresso pode ir para stdout no modo `mcp` — corrompe o protocolo. Todo diagnóstico vai para stderr.

### 6.4 Ferramentas expostas

| Tool | Input | Output |
|---|---|---|
| `search_context` | `{ query: string, topK?: number, filter?: object }` | chunks ranqueados com `source`, `headingPath`, linhas e score |
| `list_collections` | `{}` | collections disponíveis com contagem de docs/chunks |
| `get_document` | `{ source: string }` | conteúdo completo do documento (para quando o agente quer o arquivo inteiro após o retrieval) |

Descrição de `search_context` deve ser escrita para o agente entender *quando* chamar: buscar em documentação e código indexados localmente antes de responder perguntas sobre esses projetos.

Erros retornam mensagem legível (nunca stack trace) — o agente precisa conseguir agir sobre ela.

---

## 7. Configuração

`ragkit.config.ts`:
```ts
export default defineConfig({
  collection: "pessoal",
  dbPath: "~/.ragkit/pessoal.db",
  roots: ["~/notas", "~/specs", "~/projetos/*/docs"],   // base transversal; `ragkit ingest` sem argumento usa isto
  embeddings: { provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434" },
  chunking: { size: 800, overlap: 120 },
  retrieval: { topK: 8, minScore: 0.3, contextTokens: 4000, rrfK: 60 },
  ignore: ["**/*.lock", "**/coverage/**"],
});
```
Sem env vars obrigatórias. `OLLAMA_BASE_URL` opcional.

---

## 8. Erros e robustez

Erros tipados com mensagem acionável:
- `OllamaUnavailableError` → "Ollama não respondeu em http://localhost:11434. Rode `ollama serve`."
- `ModelNotFoundError` → "Modelo nomic-embed-text não encontrado. Rode `ollama pull nomic-embed-text`."
- `DimensionMismatchError` → "Collection criada com 768 dim (nomic-embed-text); modelo atual gera 1024. Use `ragkit init --force` para recriar."
- Ingestão parcialmente falha não aborta o lote: acumula e reporta no fim.

Logging: silencioso por padrão, `--verbose` para detalhe, sempre com barra de progresso na ingestão.

---

## 9. Ordem de implementação

1. **Base:** tipos, config, schema SQLite + migrations, `store.ts` com upsert/search/delete/stats. Testes.
2. **Ingestão:** loaders + ignore rules, chunker markdown e code, embedder Ollama com cache, fluxo incremental por hash. `ragkit ingest`, `ragkit stats`, `ragkit doctor`.
3. **Retrieval:** busca densa, FTS, RRF, context builder. `ragkit query` e `--explain`.
4. **MCP:** servidor stdio com as três ferramentas, docs de registro no cliente.
5. **Polimento:** `--watch`, `ragkit init` interativo, README com diagrama do pipeline e GIF do `--explain`, backlog explícito (pgvector, eval, HTTP, painel).

### Critérios de aceite
- [ ] `ragkit init && ragkit ingest ./docs && ragkit query "..."` funciona sem nenhuma API key nem acesso à rede
- [ ] Reingerir pasta inalterada de ~200 arquivos leva < 2s e reporta `unchanged`
- [ ] Arquivo alterado reindexa só ele; arquivo deletado some da base
- [ ] Busca por nome exato de função retorna o chunk certo (valida a perna lexical)
- [ ] `--explain` mostra as duas pernas, o RRF e o contexto final
- [ ] `ragkit ingest` sem argumento reindexa todos os `roots` configurados
- [ ] Agente MCP consegue chamar `search_context` e citar `source` + linhas na resposta
- [ ] Registrado no Claude Code com `--scope user`, aparece como `connected` em `/mcp` a partir de qualquer projeto
- [ ] `ragkit mcp` não escreve nada em stdout além do protocolo MCP
- [ ] Em uma pergunta sobre um projeto antigo não aberto na sessão, o agente escolhe chamar `search_context` sozinho (valida a descrição da tool)
- [ ] Interfaces de store e embeddings permitem adicionar pgvector/Gemini sem tocar em `retriever.ts` ou no CLI
- [ ] Cobertura de testes ≥ 80% em `src/core`

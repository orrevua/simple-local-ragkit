# Running ragkit on a server

ragkit is local-first, and the default setup never leaves your machine. This
guide is for when you *want* to share a collection, for example a team docs
search or a retrieval backend for an agent running elsewhere. Read the
security notes first.

## What changes on a server

- **Embeddings:** there is usually no Ollama on a free tier. Either run Ollama
  next to ragkit (needs ~1 GB RAM for `nomic-embed-text`), or switch to
  `provider: "openai"` with `text-embedding-3-small` (768 dims are requested
  automatically). `hash` works anywhere, but it's lexical only.
- **Auth:** set `RAGKIT_API_TOKEN`. Without it, anyone who can reach the port
  can read every indexed document.
- **Storage:** the SQLite DB must live on a persistent volume, or every deploy
  re-embeds everything.

## Docker

```bash
docker build -t ragkit .
docker run --rm -p 8787:8787 \
  -v "$PWD/examples/fastapi-docs:/data" \
  -e RAGKIT_API_TOKEN=change-me \
  ragkit
```

The container runs an incremental `ingest`, then `serve` on `$PORT`.

## Fly.io (free allowance)

```bash
fly launch --no-deploy            # pick a name and region, keep the Dockerfile
fly volumes create ragkit_data --size 1
fly secrets set RAGKIT_API_TOKEN=$(openssl rand -hex 24) OPENAI_API_KEY=sk-...
```

In `fly.toml`, mount the volume at `/data` and copy your `ragkit.config.ts`
and documents onto it (or bake them into a derived image). Then `fly deploy`.

## Render / Railway

Both build the Dockerfile directly. Add a persistent disk mounted at `/data`,
set the same secrets, and set the health check path to `/health`.

> The Dockerfile has not been built in CI yet. If something breaks, `npm ci`
> compiling `better-sqlite3` is the usual suspect: add
> `RUN apt-get update && apt-get install -y python3 make g++` to the build stage.

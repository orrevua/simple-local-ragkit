# MCP setup

`ragkit mcp` is a Model Context Protocol (MCP) server that runs over stdio and
exposes your indexed knowledge base to an AI agent. It is launched by the MCP
client (Claude, etc.); you rarely run it by hand except when debugging.

## Prerequisites

- A ragkit config (`ragkit.config.ts`) and an indexed collection
  (`ragkit ingest`). The MCP server reads the collection database referenced by
  the config's `dbPath`.
- Ollama running with the configured embed model pulled — `search_context`
  embeds the query at request time, so the server needs Ollama reachable.

## Tools

The server registers exactly three tools (a deliberate hard cap to keep the
agent's tool budget small and its decisions crisp):

| Tool | Input | Returns |
| --- | --- | --- |
| `search_context` | `{ query, topK?, filter? }` | An assembled `<context>` block plus a `Sources:` list of `[n] source:lines — headingPath (score)` citations. |
| `list_collections` | `{}` | One line per collection: `name: N documents, M chunks`. |
| `get_document` | `{ source }` | The full document content for the given root-relative source path. |

`get_document` resolves `source` (stored root-relative, forward slashes) against
the config `roots` and re-reads the file from disk for true full content. If the
file has been deleted, it falls back to reassembling the document from its stored
chunks in `idx` order (note: chunk overlap can repeat spans at boundaries). If no
document matches, it returns a readable `document not found: <source>` message
rather than an error.

All tool errors are caught and returned as human-readable text with `isError:
true` — never a raw stack trace.

## Registration

### Claude CLI

```powershell
claude mcp add --transport stdio ragkit --scope user -- npx -y ragkit mcp --collection pessoal
```

### JSON (`mcpServers`)

```json
{
  "mcpServers": {
    "ragkit": {
      "command": "npx",
      "args": ["-y", "ragkit", "mcp", "--collection", "pessoal"]
    }
  }
}
```

## Scopes

`claude mcp add` supports three scopes:

- **local** — only the current directory/session. Good for a repo-specific base.
- **project** — shared with a project (committed config); the base is tied to
  that project.
- **user** — available across every project you open.

Use **`--scope user`** for a personal knowledge base: it is transversal by
nature — your notes, past specs, and archived repos are useful regardless of
which project is open in the current session. A project- or local-scoped
registration would hide the base from every other workspace.

## No hot reload

The MCP client caches the tool list and the server process at connection time.
Re-indexing (`ragkit ingest`) updates the underlying data and is picked up on the
next `search_context` call, but changes to the server itself (new version, config
changes) require restarting the client or reconnecting its MCP session.

## Debugging a `disconnected` server

If `/mcp` shows ragkit as `disconnected`, the stdio process failed to start. The
client hides the reason, so run the exact command yourself in a terminal:

```powershell
ragkit mcp --collection pessoal
```

Startup failures print a single legible, actionable line to **stderr** and exit
non-zero — for example a missing config, a missing collection database, or Ollama
being unreachable. Fix the reported cause, then reconnect the client. (The
process blocks waiting for stdio input once it starts successfully; that is
expected — press Ctrl+C to stop it.)

## stdout purity

The stdio transport owns stdout exclusively: **nothing but MCP protocol frames
is ever written there.** Every diagnostic, progress line, and error goes to
stderr. This is why a stray `console.log` or a dependency banner would corrupt
the connection — ragkit routes all logging through a stderr-only logger to
guarantee it. Do not wrap the command in anything that injects text into its
stdout.

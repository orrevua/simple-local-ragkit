import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve a config `dbPath` to a concrete filesystem path, expanding a leading
 * `~` and ensuring the parent directory exists so better-sqlite3 can create the
 * file. `loadConfig` already normalizes `~`, but callers may pass raw paths.
 */
export function expandDbPath(dbPath: string): string {
  let p = dbPath;
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(2));
  }
  const resolved = path.resolve(p);
  mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

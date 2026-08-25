import pc from "picocolors";

/**
 * All logging is routed to stderr so stdout stays reserved for machine-facing
 * output (MCP protocol frames, `--json`). Nothing here writes to stdout (R9).
 */

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function info(message: string): void {
  if (verbose) write(message);
}

export function warn(message: string): void {
  write(pc.yellow(`warn: ${message}`));
}

export function error(message: string): void {
  write(pc.red(`error: ${message}`));
}

export function success(message: string): void {
  write(pc.green(message));
}

/**
 * Minimal `N/M` progress indicator writing to stderr. When the stream is not a
 * TTY (piped, CI) it stays silent to avoid noise; the final tally is printed by
 * the caller regardless.
 */
export function createProgress(total: number, label: string): {
  tick(): void;
  done(): void;
} {
  const tty = process.stderr.isTTY === true;
  let current = 0;

  const render = (): void => {
    if (!tty) return;
    process.stderr.write(`\r${label}: ${current}/${total}`);
  };

  return {
    tick(): void {
      current += 1;
      render();
    },
    done(): void {
      if (tty) process.stderr.write("\n");
    },
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import * as log from "../src/core/logger.js";

function capture(fn: () => void): { out: string; err: string } {
  let out = "";
  let err = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  try {
    fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err };
}

afterEach(() => {
  log.setVerbose(false);
});

describe("logger (R9)", () => {
  it("writes warn/error/success to stderr, never stdout", () => {
    const { out, err } = capture(() => {
      log.warn("careful");
      log.error("broke");
      log.success("done");
    });
    expect(out).toBe("");
    expect(err).toContain("careful");
    expect(err).toContain("broke");
    expect(err).toContain("done");
  });

  it("suppresses info until verbose is enabled", () => {
    const quiet = capture(() => log.info("hidden"));
    expect(quiet.err).toBe("");
    expect(quiet.out).toBe("");

    log.setVerbose(true);
    const loud = capture(() => log.info("shown"));
    expect(loud.err).toContain("shown");
    expect(loud.out).toBe("");
  });
});

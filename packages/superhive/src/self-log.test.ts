import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { redirectOutputToLog } from "./self-log.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fakeStreams = () => ({
  stdout: new PassThrough() as unknown as NodeJS.WriteStream,
  stderr: new PassThrough() as unknown as NodeJS.WriteStream,
});

describe("redirectOutputToLog", () => {
  it("does nothing unless the background launcher asked for it", () => {
    const streams = fakeStreams();
    const write = streams.stdout.write;
    expect(redirectOutputToLog({ HIVE_REMOTE_JOIN_LOG: "/tmp/x.log" }, streams)).toBe(false);
    expect(streams.stdout.write).toBe(write);
  });

  it("appends stdout and stderr to the log and calls write callbacks", () => {
    dir = mkdtempSync(path.join(tmpdir(), "hive-self-log-"));
    const logFile = path.join(dir, "a.log");
    const env: NodeJS.ProcessEnv = {
      HIVE_REMOTE_JOIN_LOG: logFile,
      HIVE_REMOTE_JOIN_SELF_LOG: "1",
    };
    const streams = fakeStreams();
    expect(redirectOutputToLog(env, streams)).toBe(true);
    expect(env).not.toHaveProperty("HIVE_REMOTE_JOIN_SELF_LOG");
    let called = false;
    streams.stdout.write("hello\n", () => (called = true));
    streams.stderr.write(Buffer.from("oops\n"));
    expect(called).toBe(true);
    expect(readFileSync(logFile, "utf8")).toBe("hello\noops\n");
  });
});

import { describe, expect, it } from "vitest";
import { defaultCommandRunner } from "./command-runner.js";

describe("defaultCommandRunner", () => {
  it("writes input to stdin and closes the stream", async () => {
    const result = await defaultCommandRunner(
      process.execPath,
      [
        "-e",
        "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write(input));",
      ],
      { cwd: process.cwd(), input: "Hive prompt" },
    );

    expect(result.stdout).toBe("Hive prompt");
    expect(result.stderr).toBe("");
  });
});

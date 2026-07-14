#!/usr/bin/env node
import { run } from "./run.js";

run("echo").catch((error: unknown) => {
  console.error(`[hive] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

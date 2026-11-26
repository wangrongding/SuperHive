import { readFile } from "node:fs/promises";
import path from "node:path";

export async function feedbackInfo(commit?: string, directory = import.meta.dirname) {
  const candidates = [
    { root: path.resolve(directory, "../../../packages/superhive"), runMode: "source" as const },
    { root: path.resolve(directory, "../.."), runMode: "npm" as const },
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(path.join(candidate.root, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "superhive" && typeof pkg.version === "string") {
        return {
          version: pkg.version,
          runMode: candidate.runMode,
          ...(commit && /^[\da-f]{7,64}$/i.test(commit) ? { commit } : {}),
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

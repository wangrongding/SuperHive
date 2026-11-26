import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

let sourceRoot;
let outputRoot;

export function initialize({ sourceDir, outputDir }) {
  sourceRoot = pathToFileURL(fs.realpathSync(sourceDir) + path.sep).href;
  outputRoot = path.resolve(outputDir);
}

function compiledFile(url) {
  if (!url.startsWith(sourceRoot)) return;
  const relative = fileURLToPath(url).slice(fileURLToPath(sourceRoot).length);
  return path.join(outputRoot, relative.replace(/\.ts$/, ".js"));
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && specifier.startsWith(".")) {
    const url = new URL(specifier, context.parentURL).href;
    const file = compiledFile(url);
    if (file && fs.existsSync(file)) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const file = compiledFile(url);
  if (file) return { format: "module", source: fs.readFileSync(file, "utf8"), shortCircuit: true };
  return nextLoad(url, context);
}

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { expect, it, vi } from "vitest";
import { hiveFavicon } from "./favicon-plugin";

it("bundles badges from the public SVG and preserves /favicon.svg without duplicate icon sources", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hive-favicon-"));
  const canonical = readFileSync(
    fileURLToPath(new URL("./public/favicon.svg", import.meta.url)),
    "utf8",
  );
  try {
    mkdirSync(path.join(root, "public"));
    writeFileSync(path.join(root, "public/favicon.svg"), canonical);
    writeFileSync(path.join(root, "index.html"), '<script type="module" src="/main.js"></script>');
    writeFileSync(
      path.join(root, "main.js"),
      'import svg from "virtual:hive-favicon"; document.title = svg;',
    );
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [hiveFavicon()],
    });
    expect(readFileSync(path.join(root, "dist/favicon.svg"), "utf8")).toBe(canonical);
    const bundles = Array.isArray(result) ? result : "output" in result ? [result] : [];
    const chunks = bundles
      .flatMap((bundle) => bundle.output)
      .filter((output) => output.type === "chunk");
    expect(chunks.some((chunk) => chunk.code.includes("<svg"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("invalidates the badge source when the canonical public favicon changes during development", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hive-favicon-dev-"));
  mkdirSync(path.join(root, "public"));
  const source = path.join(root, "public/favicon.svg");
  writeFileSync(source, '<svg id="original"/>');
  writeFileSync(
    path.join(root, "main.js"),
    'import svg from "virtual:hive-favicon"; document.title = svg;',
  );
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [hiveFavicon()],
    server: { port: 0, host: "127.0.0.1" },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== "object") throw new Error("Vite did not open a test port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fetch(`${baseUrl}/main.js`);
    const readModule = () =>
      fetch(`${baseUrl}/@id/__x00__hive-favicon`).then((response) => response.text());
    expect(await readModule()).toContain("original");
    writeFileSync(source, '<svg id="updated"/>');
    await vi.waitFor(async () => {
      expect(await readModule()).toContain("updated");
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

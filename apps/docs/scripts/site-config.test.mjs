import assert from "node:assert/strict";
import test from "node:test";
import { getSiteConfig, prefixContentUrls, withBase } from "./site-config.mjs";
import { expectedRoutes } from "./navigation.mjs";

test("unconfigured previews cannot be indexed", () => {
  assert.equal(getSiteConfig({}).indexable, false);
  assert.equal(getSiteConfig({}).base, "/");
});

test("HTTPS production origin enables indexing, explicit noindex disables it", () => {
  assert.equal(getSiteConfig({ DOCS_SITE_URL: "https://docs.superhive.org" }).indexable, true);
  assert.equal(
    getSiteConfig({ DOCS_SITE_URL: "https://docs.superhive.org", DOCS_NOINDEX: "true" }).indexable,
    false,
  );
  assert.equal(getSiteConfig({ DOCS_SITE_URL: "http://localhost:4321" }).indexable, false);
  assert.equal(getSiteConfig({ DOCS_SITE_URL: "https://127.0.0.1" }).indexable, false);
});

test("canonical origin rejects credentials, paths, query strings and non-web protocols", () => {
  for (const site of [
    "https://user:secret@host.com",
    "https://host.com/docs/",
    "https://host.com/?query=1",
    "https://host.com/#hash",
    "file:///",
  ]) {
    assert.throws(() => getSiteConfig({ DOCS_SITE_URL: site }));
  }
});

test("subpath is normalized once and unsafe paths are rejected", () => {
  assert.equal(getSiteConfig({ DOCS_BASE_PATH: "/handbook/" }).base, "/handbook/");
  assert.equal(withBase("/guides/agents/", "/handbook/"), "/handbook/guides/agents/");
  for (const base of ["docs", "/docs", "//", "/../", "/a?b/"]) {
    assert.throws(() => getSiteConfig({ DOCS_BASE_PATH: base }));
  }
});

test("Markdown links and images respect base, anchors and external URLs stay untouched", () => {
  const nodes = [
    { type: "element", properties: { href: "/guides/agents/" } },
    { type: "element", properties: { src: "/media/diagram.svg" } },
    { type: "element", properties: { href: "#section" } },
    { type: "element", properties: { href: "https://other.com/" } },
    { type: "element", properties: { href: "//other.com/" } },
  ];
  prefixContentUrls("/handbook/")()({ children: nodes });
  assert.equal(nodes[0].properties.href, "/handbook/guides/agents/");
  assert.equal(nodes[1].properties.src, "/handbook/media/diagram.svg");
  assert.equal(nodes[2].properties.href, "#section");
  assert.equal(nodes[3].properties.href, "https://other.com/");
  assert.equal(nodes[4].properties.href, "//other.com/");
});

test("local illustrations receive dimensions and lazy loading", () => {
  const image = { type: "element", tagName: "img", properties: { src: "/media/workroom.svg" } };
  prefixContentUrls("/handbook/")()({ children: [image] });
  assert.equal(image.properties.width, 680);
  assert.equal(image.properties.height, 460);
  assert.equal(image.properties.loading, "lazy");
  assert.equal(image.properties.src, "/handbook/media/workroom.svg");
});

test("navigation requires twenty-four unique documentation routes in each language", () => {
  assert.equal(expectedRoutes.length, 48);
  assert.equal(new Set(expectedRoutes).size, 48);
  assert.ok(expectedRoutes.includes("reference/telemetry/"));
  assert.ok(expectedRoutes.includes("en/reference/telemetry/"));
  assert.ok(expectedRoutes.includes("reference/documentation/"));
  assert.ok(expectedRoutes.includes("en/reference/documentation/"));
  assert.ok(expectedRoutes.includes("en/"));
  assert.ok(expectedRoutes.includes("guides/contributing/"));
  assert.ok(expectedRoutes.includes("en/guides/contributing/"));
  assert.ok(expectedRoutes.includes("guides/cloud-deployment/"));
  assert.ok(expectedRoutes.includes("en/guides/cloud-deployment/"));
  assert.ok(expectedRoutes.includes("guides/plugins/"));
  assert.ok(expectedRoutes.includes("en/guides/plugins/"));
  assert.ok(expectedRoutes.includes("guides/updating/"));
  assert.ok(expectedRoutes.includes("en/guides/updating/"));
});

test("interface screenshots expand into themed 2x image pairs", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "img",
            properties: { src: "/media/screens/ask.png", alt: "提问卡片" },
          },
        ],
      },
    ],
  };
  prefixContentUrls("/handbook/")()(tree);
  const images = tree.children[0].children;
  assert.deepEqual(
    images.map((image) => [image.properties.src, image.properties.className.join(" ")]),
    [
      ["/handbook/media/screens/ask.light.png", "docs-shot dark:sl-hidden"],
      ["/handbook/media/screens/ask.dark.png", "docs-shot light:sl-hidden"],
    ],
  );
  assert.ok(images.every((image) => image.properties.alt === "提问卡片"));
  assert.ok(
    images.every(
      (image) => Number.isInteger(image.properties.width) && image.properties.width < 900,
    ),
  );
});

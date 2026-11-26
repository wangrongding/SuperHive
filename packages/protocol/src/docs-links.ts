/**
 * 文档站地址：网页的「帮助与文档」和各处就地链接都从这里取，换域名只改 DOCS_BASE_URL。
 * CLI（superhive 包不依赖 protocol）里有一份同值的常量，由 superhive 的 docs-url.test.ts 核对。
 *
 * 中文是根语言，英文页在 /en/ 下，路径一一对应。锚点按标题生成（Starlight 用 github-slugger），
 * 中英标题不同，所以两种语言各写一个；apps/docs 的 docs-links.test.mjs 核对页面和锚点都真实存在。
 */
export const DOCS_BASE_URL = "https://wangrongding.github.io/SuperHive/";

export type DocsLocale = "zh-CN" | "en";

export type DocsLink = {
  /** 相对站点根目录的页面路径，以 / 结尾；空串是首页 */
  path: string;
  anchor?: Record<DocsLocale, string>;
};

export const DOCS_LINKS = {
  home: { path: "" },
  agentSetup: {
    path: "guides/agents/",
    anchor: {
      "zh-CN": "从网页手动完成三步接入",
      en: "add-an-agent-from-the-web-app-in-three-steps",
    },
  },
  permissions: {
    path: "guides/permissions/",
    anchor: { "zh-CN": "选择最小够用的档位", en: "pick-the-least-access-that-does-the-job" },
  },
  im: { path: "guides/im/" },
  incidents: {
    path: "reference/troubleshooting/",
    anchor: {
      "zh-CN": "页面卡顿agent-起不来或同一种报错反复出现",
      en: "the-page-is-slow-agents-wont-start-or-the-same-error-keeps-coming-back",
    },
  },
  worktrees: { path: "guides/worktrees/" },
  contributing: { path: "guides/contributing/" },
  plugins: { path: "guides/plugins/" },
} satisfies Record<string, DocsLink>;

export type DocsLinkKey = keyof typeof DOCS_LINKS;

export function docsUrl(key: DocsLinkKey, locale: DocsLocale = "zh-CN"): string {
  const link: DocsLink = DOCS_LINKS[key];
  const prefix = locale === "en" ? "en/" : "";
  const hash = link.anchor ? `#${encodeURIComponent(link.anchor[locale])}` : "";
  return `${DOCS_BASE_URL}${prefix}${link.path}${hash}`;
}

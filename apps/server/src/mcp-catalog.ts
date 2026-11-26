import type { McpCatalog, McpCatalogEntry, RuntimeCredentialProvider } from "@superhive/protocol";

/**
 * MCP 快速安装的精选清单：每条是一份「配方」——固定版本的启动命令（逐项 argv）或远程地址、
 * 要填的参数和密钥字段、能装进哪些 CLI、发布者文档。这里不存任何密钥，也不是另一份 MCP 主列表：
 * 装完以后照旧从各 CLI 自己的配置文件读回来，在 Hive 外改了也以文件为准。
 *
 * 维护约定：
 * - 版本写死（npm 用 pkg@x.y.z，PyPI 用 pkg==x.y.z），升级就改这里并升 MCP_CATALOG_VERSION；
 * - secret 类参数只能出现在 env / headers 模板里，不能进 args（测试会检查）；
 * - 需要 OAuth 浏览器登录的服务先不收（第一阶段不做 OAuth）。
 */

export const MCP_CATALOG_VERSION = "2026.11.27";

/** 远程 MCP 各 CLI 都能表达（Codex 的请求头写成 http_headers）；OpenClaw 不支持全局 MCP，不列 */
const ALL: RuntimeCredentialProvider[] = ["claude", "codex", "opencode", "omp", "copilot"];

const ENTRIES: McpCatalogEntry[] = [
  {
    id: "chrome-devtools",
    name: "chrome-devtools",
    title: "Chrome DevTools",
    publisher: "Chrome DevTools (Google)",
    description: {
      zh: "让 Agent 用这台电脑上的 Chrome 打开网页、截图，看页面报了什么错、加载慢在哪里。适合查网页问题。",
      en: "Lets agents use Chrome on this computer to open pages, take screenshots, and see what errors a page shows and why it loads slowly. Good for debugging websites.",
    },
    tagline: {
      zh: "让 Agent 打开和检查你的 Chrome 浏览器",
      en: "Let agents open and inspect your Chrome browser",
    },
    category: "browser",
    badge: { zh: "需要 Chrome", en: "Needs Chrome" },
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@1.14.0"],
    params: [],
    runtimes: ALL,
    requires: {
      zh: "这台电脑要装好 Node.js（20.19 以上）和 Chrome。",
      en: "This computer needs Node.js 20.19+ and Chrome.",
    },
  },
  {
    id: "playwright",
    name: "playwright",
    title: "Playwright",
    publisher: "Microsoft",
    description: {
      zh: "让 Agent 像人一样点按钮、填表单、翻页，适合自动跑一遍网页流程、做网页测试。",
      en: "Lets agents click buttons, fill in forms and move between pages like a person would. Good for walking through a site and testing it.",
    },
    tagline: {
      zh: "让 Agent 自动点网页、填表、做网页测试",
      en: "Let agents click through sites, fill forms and test web pages",
    },
    category: "browser",
    docs: "https://github.com/microsoft/playwright-mcp",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.86"],
    params: [],
    runtimes: ALL,
    requires: {
      zh: "这台电脑要装好 Node.js（18 以上）；第一次用时会自动下载浏览器。",
      en: "This computer needs Node.js 18+; the first run downloads a browser.",
    },
  },
  {
    id: "context7",
    name: "context7",
    title: "Context7",
    publisher: "Upstash",
    description: {
      zh: "写代码时按版本查各种库最新的官方文档和示例，Agent 就不会凭记忆写出过时的用法。",
      en: "Looks up the latest official docs and examples for the exact library version, so agents don't write outdated code from memory.",
    },
    tagline: {
      zh: "查各种代码库最新的官方文档",
      en: "Look up the latest docs for any code library",
    },
    category: "docs",
    docs: "https://github.com/upstash/context7",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "{apiKey}" },
    params: [
      {
        id: "apiKey",
        label: { zh: "Context7 密钥（可选）", en: "Context7 key (optional)" },
        help: {
          zh: "不填也能用；填了每天能查更多次。登录 context7.com 后在控制台里复制。",
          en: "Works without one; a key raises rate limits. Get it from the context7.com dashboard.",
        },
        getUrl: "https://context7.com/dashboard",
        kind: "secret",
        required: false,
      },
    ],
    runtimes: ALL,
  },
  {
    id: "github",
    name: "github",
    title: "GitHub",
    publisher: "GitHub",
    description: {
      zh: "GitHub 官方出品。让 Agent 看代码、开问题和 PR、查自动构建结果。需要一个 GitHub 令牌，能访问哪些仓库由你决定。",
      en: "Made by GitHub. Lets agents read code, open issues and pull requests, and check build results. Needs a GitHub token; you decide which repositories it can reach.",
    },
    tagline: {
      zh: "让 Agent 看和处理 GitHub 上的仓库、问题和 PR",
      en: "Let agents work with GitHub repos, issues and pull requests",
    },
    category: "code",
    docs: "https://github.com/github/github-mcp-server",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer {token}" },
    params: [
      {
        id: "token",
        label: { zh: "GitHub 令牌", en: "GitHub token" },
        help: {
          zh: "在 GitHub 新建一个令牌，选好允许 Agent 访问的仓库和权限，复制粘贴到这里。",
          en: "Create a token on GitHub, pick the repositories and permissions agents may use, then paste it here.",
        },
        getUrl: "https://github.com/settings/personal-access-tokens/new",
        kind: "secret",
        required: true,
      },
    ],
    runtimes: ALL,
  },
  {
    id: "figma-desktop",
    name: "figma",
    title: "Figma Desktop",
    publisher: "Figma",
    description: {
      zh: "让 Agent 读你在 Figma 桌面版里选中的设计稿、颜色和组件，照着设计写界面。",
      en: "Lets agents read the frames, colors and components you select in the Figma desktop app, so they can build the UI from your design.",
    },
    tagline: {
      zh: "让 Agent 读你在 Figma 里选中的设计稿",
      en: "Let agents read the designs you select in Figma",
    },
    category: "design",
    badge: { zh: "需要 Figma 桌面版", en: "Needs Figma desktop" },
    docs: "https://developers.figma.com/docs/figma-mcp-server/",
    transport: "http",
    url: "http://127.0.0.1:3845/mcp",
    params: [],
    runtimes: ALL,
    requires: {
      zh: "要先打开 Figma 桌面版，在 Dev Mode 里打开「MCP 服务器」。",
      en: "Turn on the MCP server in Dev Mode of the Figma desktop app first.",
    },
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    publisher: "Model Context Protocol",
    description: {
      zh: "让 Agent 读写文件，但只能碰你指定的那几个文件夹。",
      en: "Lets agents read and write files, but only in the folders you choose.",
    },
    tagline: {
      zh: "只让 Agent 读写你指定的文件夹",
      en: "Let agents read and write only the folders you choose",
    },
    category: "other",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2.4.0", "{dirs}"],
    params: [
      {
        id: "dirs",
        label: { zh: "允许 Agent 读写的文件夹", en: "Folders agents may use" },
        help: { zh: "一行一个完整路径。", en: "One full path per line." },
        kind: "paths",
        required: true,
        placeholder: "/Users/me/projects",
      },
    ],
    runtimes: ALL,
    requires: { zh: "这台电脑要装好 Node.js（18 以上）。", en: "This computer needs Node.js 18+." },
  },
  {
    id: "git",
    name: "git",
    title: "Git",
    publisher: "Model Context Protocol",
    description: {
      zh: "让 Agent 查看这台电脑上项目的改动和历史，帮你提交、切换分支。",
      en: "Lets agents see changes and history in projects on this computer, commit, and switch branches.",
    },
    tagline: {
      zh: "让 Agent 看改动、历史并提交代码",
      en: "Let agents see changes and history, and commit code",
    },
    category: "code",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git==2026.11.18", "--repository={repository}"],
    params: [
      {
        id: "repository",
        label: { zh: "默认项目文件夹（可选）", en: "Default project folder (optional)" },
        help: {
          zh: "填一个 Git 项目的完整路径；不填就由 Agent 每次自己指定。",
          en: "Full path of a Git project; leave empty to let the agent choose each time.",
        },
        kind: "path",
        required: false,
      },
    ],
    runtimes: ALL,
    requires: { zh: "这台电脑要装好 uv。", en: "This computer needs uv." },
  },
  {
    id: "fetch",
    name: "fetch",
    title: "Fetch",
    publisher: "Model Context Protocol",
    description: {
      zh: "给 Agent 一个网址，它就能打开并读懂网页上的文字。",
      en: "Give agents a link and they can open it and read the text on the page.",
    },
    tagline: {
      zh: "让 Agent 打开网页并读里面的内容",
      en: "Let agents open a web page and read it",
    },
    category: "docs",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch==2026.11.18"],
    params: [],
    runtimes: ALL,
    requires: {
      zh: "这台电脑要装好 uv。它能打开这台电脑能打开的任何网址，包括公司内网。",
      en: "This computer needs uv. It can open anything this computer can reach, including the local network.",
    },
  },
  {
    id: "memory",
    name: "memory",
    title: "Memory",
    publisher: "Model Context Protocol",
    description: {
      zh: "让 Agent 把你交代过的事记在这台电脑上，换个对话也还记得。",
      en: "Lets agents keep notes on this computer about what you've told them, so they still remember in a new conversation.",
    },
    tagline: {
      zh: "让 Agent 记住你说过的事，下次还记得",
      en: "Let agents remember things across conversations",
    },
    category: "other",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory@2.2.1"],
    params: [],
    runtimes: ALL,
    requires: { zh: "这台电脑要装好 Node.js（18 以上）。", en: "This computer needs Node.js 18+." },
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    publisher: "Model Context Protocol",
    description: {
      zh: "遇到复杂问题时，让 Agent 先一步步拆开想清楚，想错了还能回头改。",
      en: "Helps agents break a hard problem into steps and think it through, going back to fix a step when needed.",
    },
    tagline: {
      zh: "让 Agent 遇到难题时一步步想清楚",
      en: "Help agents think hard problems through step by step",
    },
    category: "other",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.2.0"],
    params: [],
    runtimes: ALL,
    requires: { zh: "这台电脑要装好 Node.js（18 以上）。", en: "This computer needs Node.js 18+." },
  },
  {
    id: "brave-search",
    name: "brave-search",
    title: "Brave Search",
    publisher: "Brave",
    description: {
      zh: "让 Agent 上网搜网页、新闻和图片。需要一个 Brave 搜索密钥（有免费额度）。",
      en: "Lets agents search the web, news and images. Needs a Brave Search key (there's a free tier).",
    },
    tagline: { zh: "让 Agent 上网搜索", en: "Let agents search the web" },
    category: "docs",
    docs: "https://github.com/brave/brave-search-mcp-server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server@2.2.0"],
    env: { BRAVE_API_KEY: "{apiKey}" },
    params: [
      {
        id: "apiKey",
        label: { zh: "Brave 搜索密钥", en: "Brave Search key" },
        help: {
          zh: "在 Brave 搜索 API 网站注册（有免费额度），在 API Keys 页面复制。",
          en: "Sign up for the Brave Search API (there is a free tier) and copy it from the API Keys page.",
        },
        getUrl: "https://api-dashboard.search.brave.com/app/keys",
        kind: "secret",
        required: true,
      },
    ],
    runtimes: ALL,
    requires: { zh: "这台电脑要装好 Node.js（18 以上）。", en: "This computer needs Node.js 18+." },
  },
  {
    id: "deepwiki",
    name: "deepwiki",
    title: "DeepWiki",
    publisher: "Cognition",
    description: {
      zh: "问任何公开 GitHub 项目怎么用、代码怎么组织的，不用注册账号。",
      en: "Ask how any public GitHub project works and how its code is organized. No account needed.",
    },
    tagline: {
      zh: "问任何公开 GitHub 项目是怎么回事",
      en: "Ask questions about any public GitHub project",
    },
    category: "docs",
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    params: [],
    runtimes: ALL,
  },
];

export const MCP_CATALOG: McpCatalog = { version: MCP_CATALOG_VERSION, entries: ENTRIES };

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return ENTRIES.find((entry) => entry.id === id);
}

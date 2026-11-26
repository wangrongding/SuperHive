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

export const MCP_CATALOG_VERSION = "2026.11.26";

/** 远程 MCP 各 CLI 都能表达（Codex 的请求头写成 http_headers）；OpenClaw 不支持全局 MCP，不列 */
const ALL: RuntimeCredentialProvider[] = ["claude", "codex", "opencode", "omp", "copilot"];

const ENTRIES: McpCatalogEntry[] = [
  {
    id: "chrome-devtools",
    name: "chrome-devtools",
    title: "Chrome DevTools",
    publisher: "Chrome DevTools (Google)",
    description: {
      zh: "让 Agent 控制本机 Chrome：打开页面、看控制台和网络请求、截图、跑性能分析。",
      en: "Lets agents drive a local Chrome: open pages, read console and network, take screenshots and record performance traces.",
    },
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@1.14.0"],
    params: [],
    runtimes: ALL,
    requires: { zh: "需要 Node.js 20.19+ 和本机 Chrome。", en: "Needs Node.js 20.19+ and Chrome." },
  },
  {
    id: "playwright",
    name: "playwright",
    title: "Playwright",
    publisher: "Microsoft",
    description: {
      zh: "用 Playwright 操作浏览器，按无障碍树定位元素，适合做网页测试和自动化。",
      en: "Browser automation with Playwright using the accessibility tree, good for web testing.",
    },
    docs: "https://github.com/microsoft/playwright-mcp",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.86"],
    params: [],
    runtimes: ALL,
    requires: {
      zh: "需要 Node.js 18+；第一次运行会下载浏览器。",
      en: "Needs Node.js 18+; the first run downloads a browser.",
    },
  },
  {
    id: "context7",
    name: "context7",
    title: "Context7",
    publisher: "Upstash",
    description: {
      zh: "按版本查第三方库的最新文档和代码示例，减少 Agent 凭记忆写过时的 API。",
      en: "Up-to-date, version-specific library docs and code examples for agents.",
    },
    docs: "https://github.com/upstash/context7",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "{apiKey}" },
    params: [
      {
        id: "apiKey",
        label: { zh: "API Key（可选）", en: "API key (optional)" },
        help: {
          zh: "不填也能用，填了额度更高。在 context7.com 的控制台里申请。",
          en: "Works without one; a key raises rate limits. Get it from the context7.com dashboard.",
        },
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
      zh: "GitHub 官方远程 MCP：读写仓库、issue、PR、Actions。用个人访问令牌（PAT）鉴权。",
      en: "GitHub's official remote MCP server: repos, issues, pull requests and Actions, authenticated with a personal access token.",
    },
    docs: "https://github.com/github/github-mcp-server",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer {token}" },
    params: [
      {
        id: "token",
        label: { zh: "个人访问令牌（PAT）", en: "Personal access token (PAT)" },
        help: {
          zh: "在 GitHub 设置 → Developer settings 里生成，只勾需要的权限。",
          en: "Create one under GitHub Settings → Developer settings with only the scopes you need.",
        },
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
      zh: "连接 Figma 桌面版自带的本地 MCP 服务器，读取选中的设计稿、变量和组件。",
      en: "Connects to the local MCP server built into the Figma desktop app to read selected frames, variables and components.",
    },
    docs: "https://developers.figma.com/docs/figma-mcp-server/",
    transport: "http",
    url: "http://127.0.0.1:3845/mcp",
    params: [],
    runtimes: ALL,
    requires: {
      zh: "要先在 Figma 桌面版的 Dev Mode 里打开「MCP 服务器」。",
      en: "Turn on the MCP server in Dev Mode of the Figma desktop app first.",
    },
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    publisher: "Model Context Protocol",
    description: {
      zh: "只允许访问指定目录的文件读写工具。",
      en: "File read/write tools limited to the folders you allow.",
    },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2.4.0", "{dirs}"],
    params: [
      {
        id: "dirs",
        label: { zh: "允许访问的目录", en: "Allowed folders" },
        help: { zh: "绝对路径，一行一个。", en: "Absolute paths, one per line." },
        kind: "paths",
        required: true,
        placeholder: "/Users/me/projects",
      },
    ],
    runtimes: ALL,
    requires: { zh: "需要 Node.js 18+。", en: "Needs Node.js 18+." },
  },
  {
    id: "git",
    name: "git",
    title: "Git",
    publisher: "Model Context Protocol",
    description: {
      zh: "读取和操作本地 Git 仓库：状态、diff、日志、提交、分支。",
      en: "Read and operate local Git repositories: status, diff, log, commit and branches.",
    },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git==2026.11.18", "--repository={repository}"],
    params: [
      {
        id: "repository",
        label: { zh: "默认仓库（可选）", en: "Default repository (optional)" },
        help: {
          zh: "绝对路径；不填就每次调用时由 Agent 指定。",
          en: "Absolute path; leave empty to let the agent pass one per call.",
        },
        kind: "path",
        required: false,
      },
    ],
    runtimes: ALL,
    requires: { zh: "需要 uv（uvx）。", en: "Needs uv (uvx)." },
  },
  {
    id: "fetch",
    name: "fetch",
    title: "Fetch",
    publisher: "Model Context Protocol",
    description: {
      zh: "抓取网页并转成 Markdown 给 Agent 读。",
      en: "Fetches web pages and converts them to Markdown for agents.",
    },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch==2026.11.18"],
    params: [],
    runtimes: ALL,
    requires: {
      zh: "需要 uv（uvx）。它能访问本机能访问的任何地址，包括内网。",
      en: "Needs uv (uvx). It can reach anything this computer can, including the local network.",
    },
  },
  {
    id: "memory",
    name: "memory",
    title: "Memory",
    publisher: "Model Context Protocol",
    description: {
      zh: "用本地知识图谱给 Agent 记长期记忆。",
      en: "Long-term memory for agents backed by a local knowledge graph.",
    },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory@2.2.1"],
    params: [],
    runtimes: ALL,
    requires: { zh: "需要 Node.js 18+。", en: "Needs Node.js 18+." },
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    publisher: "Model Context Protocol",
    description: {
      zh: "把复杂问题拆成可修改、可分支的思考步骤。",
      en: "Structured, revisable step-by-step thinking for complex problems.",
    },
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.2.0"],
    params: [],
    runtimes: ALL,
    requires: { zh: "需要 Node.js 18+。", en: "Needs Node.js 18+." },
  },
  {
    id: "brave-search",
    name: "brave-search",
    title: "Brave Search",
    publisher: "Brave",
    description: {
      zh: "用 Brave 搜索 API 做网页、新闻、图片搜索。",
      en: "Web, news and image search through the Brave Search API.",
    },
    docs: "https://github.com/brave/brave-search-mcp-server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server@2.2.0"],
    env: { BRAVE_API_KEY: "{apiKey}" },
    params: [
      {
        id: "apiKey",
        label: { zh: "Brave Search API Key", en: "Brave Search API key" },
        help: {
          zh: "在 brave.com/search/api 申请。",
          en: "Get one at brave.com/search/api.",
        },
        kind: "secret",
        required: true,
      },
    ],
    runtimes: ALL,
    requires: { zh: "需要 Node.js 18+。", en: "Needs Node.js 18+." },
  },
  {
    id: "deepwiki",
    name: "deepwiki",
    title: "DeepWiki",
    publisher: "Cognition",
    description: {
      zh: "查公开 GitHub 仓库的文档和结构，并就仓库提问。不需要账号。",
      en: "Read docs and structure of public GitHub repositories and ask questions about them. No account needed.",
    },
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

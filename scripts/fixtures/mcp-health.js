/* global window, localStorage, location, URL, URLSearchParams, Response */
// 截图用的测试替身：「MCP 与技能」装完测能不能用、出问题时状态栏角标。沙箱里没有 CLI 配置，这里都是造的。
// 和 local-agents.js 一起用（假装页面开在 Server 所在电脑上）：
//   pnpm screenshot --url $SANDBOX_URL --init-script scripts/fixtures/local-agents.js \
//     --init-script scripts/fixtures/mcp-health.js --action click:.status-runtimes
// 「装完测」的结果放在地址的 ?mcp=（或 localStorage 的 mcp-fixture）里，页面加载前读一次：
//   ok | auth | unreachable | failed | checking（一直在测） | error（接口本身失败）
// ?mcpProblems=0 时总览里没有出问题的 MCP（看正常时不显示角标）。
// 沙箱的 /api/meta 带 sandbox 标记，状态栏会因此藏起 IM 项；这里去掉它，好截 IM 角标（配合 im.js）。
(() => {
  const query = new URLSearchParams(location.search);
  const scene = query.get("mcp") ?? localStorage.getItem("mcp-fixture") ?? "auth";
  const noProblems = query.get("mcpProblems") === "0";
  const json = (body, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const providers = [
    { provider: "claude", mcpSupported: true, mcpCanToggle: false },
    { provider: "codex", mcpSupported: true, mcpCanToggle: true },
    { provider: "opencode", mcpSupported: true, mcpCanToggle: true },
    { provider: "copilot", mcpSupported: true, mcpCanToggle: true },
    { provider: "omp", mcpSupported: true, mcpCanToggle: true },
    {
      provider: "openclaw",
      mcpSupported: false,
      mcpCanToggle: false,
      mcpNote: "OpenClaw 还不支持在配置文件里管理 MCP",
    },
  ];
  const at = Date.now() - 5 * 60_000;
  const ok = (tools) => ({ ok: true, tools, tokens: tools * 340, checkedAt: at });
  const bad = (problem, reason) => ({ ok: false, problem, reason, checkedAt: at });
  const row = (name, transport, health, only) => ({
    name,
    entries: providers
      .filter((item) => item.mcpSupported && (!only || only.includes(item.provider)))
      .map((item) => ({ provider: item.provider, enabled: true, transport })),
    ...(health && !(noProblems && !health.ok) ? { health } : {}),
  });
  const installed = [
    row("chrome-devtools", "stdio", ok(32)),
    row("context7", "http", ok(2)),
    row("deepwiki", "http", ok(3), ["claude", "codex"]),
    row("figma-desktop", "http", bad("unreachable", "连接被拒绝，服务可能没开（ECONNREFUSED）"), [
      "claude",
    ]),
    row("filesystem", "stdio"),
    row("git", "stdio", undefined, ["claude", "codex", "opencode"]),
    row("github", "http", bad("auth", "服务要求登录或密钥（HTTP 401）")),
    row("memory", "stdio", ok(9)),
    row("playwright", "stdio", ok(21)),
    row(
      "postgres-internal-analytics-readonly-replica",
      "stdio",
      bad("failed", "Connection closed：Error: Cannot find module 'pg-native'"),
      ["claude", "codex"],
    ),
    row("rea", "stdio", ok(207), ["claude"]),
    row("sentry", "http", undefined, ["claude"]),
    row("slack", "stdio", undefined, ["claude", "codex"]),
    row("time", "stdio", ok(2)),
    row("brave-search", "stdio", ok(2), ["claude"]),
    row("sequential-thinking", "stdio", ok(1)),
  ];
  let overview = { providers, mcp: installed, skills: [{ name: "pdf", entries: [] }] };

  const catalog = {
    version: "fixture",
    entries: [
      {
        id: "github",
        name: "github-work",
        title: "GitHub",
        publisher: "GitHub",
        description: {
          zh: "GitHub 官方出品。让 Agent 看代码、开问题和 PR、查自动构建结果。需要一个 GitHub 令牌，能访问哪些仓库由你决定。",
          en: "GitHub MCP",
        },
        tagline: { zh: "让 Agent 看和处理 GitHub 上的仓库、问题和 PR", en: "GitHub" },
        category: "code",
        docs: "https://github.com/github/github-mcp-server",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer {token}" },
        params: [
          {
            id: "token",
            label: { zh: "GitHub 令牌", en: "GitHub token" },
            help: { zh: "在 GitHub 新建一个细粒度令牌。", en: "Create a token" },
            getUrl: "https://github.com/settings/personal-access-tokens/new",
            kind: "secret",
            required: true,
          },
        ],
        runtimes: ["claude", "codex", "opencode", "omp", "copilot"],
      },
      {
        id: "chrome-devtools",
        name: "chrome-devtools-2",
        title: "Chrome DevTools",
        publisher: "Chrome DevTools (Google)",
        description: {
          zh: "让 Agent 用这台电脑上的 Chrome 打开网页、截图，看页面报了什么错、加载慢在哪里。适合查网页问题。",
          en: "Chrome",
        },
        tagline: { zh: "让 Agent 打开和检查你的 Chrome 浏览器", en: "Chrome" },
        category: "browser",
        badge: { zh: "需要 Chrome", en: "Needs Chrome" },
        docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
        transport: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@1.14.0"],
        params: [],
        runtimes: ["claude", "codex", "opencode", "omp", "copilot"],
        requires: {
          zh: "这台电脑要装好 Node.js（20.19 以上）和 Chrome。",
          en: "Needs Node.js and Chrome.",
        },
      },
    ],
  };
  const verdicts = {
    ok: ok(14),
    auth: bad("auth", "服务要求登录或密钥（HTTP 401）"),
    unreachable: bad("unreachable", "找不到这个地址（ENOTFOUND）"),
    failed: bad("failed", "Connection closed：npm ERR! 404 Not Found - chrome-devtools-mcp@1.14.0"),
  };

  const original = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const path = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (path === "/api/meta") {
      const response = await original(input, init);
      const meta = await response.json();
      delete meta.sandbox;
      return json(meta);
    }
    if (path === "/api/local/runtime-overview" && method === "GET") return json({ overview });
    if (path === "/api/local/runtime-install/catalog") return json(catalog);
    if (path === "/api/local/runtime-install/preview") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return json({
        plan: {
          id: "plan-1",
          expiresAt: Date.now() + 600_000,
          recipeId: body.recipeId,
          catalogVersion: "fixture",
          name: body.name,
          transport: "http",
          env: [],
          headers: [],
          targets: body.targets.map((provider) => ({
            provider,
            file: `~/.${provider}/config`,
            agents: [],
          })),
        },
      });
    }
    if (path === "/api/local/runtime-install/apply") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return json({
        results: body.targets.map((provider) => ({
          provider,
          ok: true,
          file: `~/.${provider}/config`,
        })),
        overview,
      });
    }
    if (path === "/api/local/runtime-overview/mcp/verify") {
      if (scene === "checking") return new Promise(() => {});
      if (scene === "error") return json({ error: "Server 没响应，稍后再试" }, 502);
      const body = JSON.parse(String(init.body ?? "{}"));
      const health = verdicts[scene] ?? verdicts.auth;
      overview = {
        ...overview,
        mcp: overview.mcp.map((item) => (item.name === body.name ? { ...item, health } : item)),
      };
      return json({ health });
    }
    return original(input, init);
  };
})();

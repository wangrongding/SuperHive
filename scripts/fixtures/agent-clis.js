/* global window, localStorage, location, URL, URLSearchParams, Response */
// 截图用的测试替身：「Agent 运行时」各 CLI 的版本、右下角「N 个 CLI 可更新」卡片和批量升级。
// 沙箱里 /api/local/* 是关的，也不会真的去升级本机的 CLI：这里的版本、命令、进度都是造的。
// 和 local-agents.js 一起用（假装页面开在 Server 所在电脑上），放在它后面：
//   pnpm screenshot --url $SANDBOX_URL --init-script scripts/fixtures/local-agents.js \
//     --init-script scripts/fixtures/agent-clis.js --action wait:16500
// 卡片在页面打开 15 秒后才检测、才弹，所以要先等一会儿。
// 5 个 CLI：Claude Code、Codex、Gemini CLI 能一键升级，GitHub Copilot CLI 只能手动升级，OpenCode 已是最新。
// 点「升级」后的进度按时间走（替身最多同时跑 2 个，第 3 个先排队）：
//   Claude Code 2 秒后升好；Codex 3 秒后失败（3 分钟没输出被停掉，带完整输出）；Gemini CLI 排到后 2 秒升好。
// ?clis=latest：都是最新（卡片不弹）。每次加载前清掉卡片的「稍后」记录，方便反复截。
(() => {
  const query = new URLSearchParams(location.search);
  const scene = query.get("clis") ?? "offer";
  localStorage.removeItem("superhive.cliUpdateCard.v1");
  const json = (body, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const nvm = "/Users/rd/.nvm/versions/node/v22.12.0/bin";
  const install = (path, real, version, source) => ({
    path,
    realPath: real,
    version,
    runnable: true,
    source,
    pathDefault: true,
  });
  const agent = (id, name, status = "running") => ({ id, name, status });
  const base = [
    {
      tool: "claude",
      name: "Claude Code",
      package: "@anthropic-ai/claude-code",
      version: "2.1.330",
      latest: "2.1.341",
      plan: { kind: "anchored", command: "'/Users/rd/.local/bin/claude' update" },
      installations: [
        install(
          "/Users/rd/.local/bin/claude",
          "/Users/rd/.local/share/claude/versions/2.1.330",
          "2.1.330",
          "native",
        ),
      ],
      agents: [
        agent("c1", "rd-claude"),
        agent("c2", "rd-claude2"),
        agent("c3", "rd-claude3", "stopped"),
      ],
    },
    {
      tool: "codex",
      name: "Codex",
      package: "@openai/codex",
      version: "0.171.0",
      latest: "0.174.0",
      plan: {
        kind: "anchored",
        command: `PATH='${nvm}':"$PATH" '${nvm}/npm' i -g @openai/codex@latest`,
      },
      installations: [
        install(
          `${nvm}/codex`,
          `${nvm}/../lib/node_modules/@openai/codex/bin/codex.js`,
          "0.171.0",
          "nvm",
        ),
      ],
      agents: [agent("x1", "rd-codex"), agent("x2", "rd-codex2")],
    },
    {
      tool: "gemini",
      name: "Gemini CLI",
      package: "@google/gemini-cli",
      version: "0.70.0",
      latest: "0.72.1",
      plan: {
        kind: "anchored",
        command: `PATH='${nvm}':"$PATH" '${nvm}/npm' i -g @google/gemini-cli@latest`,
      },
      installations: [
        install(
          `${nvm}/gemini`,
          `${nvm}/../lib/node_modules/@google/gemini-cli/bundle/gemini.js`,
          "0.70.0",
          "nvm",
        ),
      ],
      agents: [],
    },
    {
      tool: "copilot",
      name: "GitHub Copilot CLI",
      package: "@github/copilot",
      version: "1.0.31",
      latest: "1.0.40",
      plan: {
        kind: "manual",
        reason:
          "/Users/rd/bin/copilot 旁边找不到 npm，没法确定升级到哪一处，请用原来的安装方式升级",
        command: "npm i -g @github/copilot@latest",
      },
      installations: [
        install("/Users/rd/bin/copilot", "/Users/rd/bin/copilot", "1.0.31", "unknown"),
      ],
      agents: [agent("p1", "rd-copilot")],
    },
    {
      tool: "opencode",
      name: "OpenCode",
      package: "opencode-ai",
      version: "1.4.12",
      latest: "1.4.12",
      plan: { kind: "anchored", command: "'/Users/rd/.opencode/bin/opencode' upgrade" },
      installations: [
        install(
          "/Users/rd/.opencode/bin/opencode",
          "/Users/rd/.opencode/bin/opencode",
          "1.4.12",
          "native",
        ),
      ],
      agents: [agent("o1", "rd-opencode")],
    },
  ].map((tool) => ({
    status: "ok",
    conflict: false,
    updateAvailable: scene !== "latest" && tool.version !== tool.latest,
    ...tool,
    ...(scene === "latest" ? { version: tool.latest } : {}),
  }));
  const missing = ["omp", "openclaw", "agy"].map((tool) => ({
    tool,
    name: { omp: "Oh My Pi", openclaw: "OpenClaw", agy: "Antigravity CLI" }[tool],
    package: "",
    status: "notInstalled",
    version: null,
    installations: [],
    conflict: false,
    latest: null,
    updateAvailable: false,
    agents: [],
  }));

  /** 每个 CLI 的进度剧本：多少毫秒后什么结果 */
  const scripts = {
    claude: { runMs: 2000, lines: ["Checking for updates…", "Downloading 2.1.341…"] },
    codex: { runMs: 3000, fail: true, lines: ["npm http fetch GET 200 @openai/codex", "reify"] },
    gemini: { runMs: 2000, lines: ["npm http fetch GET 200 @google/gemini-cli", "reify: timing"] },
  };
  const LIMIT = 2;
  const jobs = new Map();
  const upgraded = new Set();
  const now = () => Date.now();
  const iso = (at) => new Date(at).toISOString();

  /** 按时间推进：排队的等前面的结束；在跑的到点出结果 */
  const tick = () => {
    const list = [...jobs.values()];
    for (const job of list) {
      if (job.state !== "running") continue;
      const script = scripts[job.tool];
      const elapsed = now() - job.runAt;
      if (elapsed >= script.runMs) {
        job.finishedAt = iso(now());
        if (script.fail) {
          job.state = "failed";
          job.reason = "命令连续 3 分钟没有任何输出，像是卡住了，已停止。";
          const output = [
            "npm warn config production Use `--omit=dev` instead.",
            "npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 182ms",
            "npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex-darwin-arm64 96ms",
            ...Array.from(
              { length: 12 },
              (_, i) =>
                `npm sill tarball no local data for @openai/codex-darwin-arm64 (${i + 1}/12)`,
            ),
            "npm http fetch GET https://registry.npmjs.org/@openai/codex/-/codex-darwin-arm64.tgz",
          ];
          job.output = output.join("\n");
          job.error = output.slice(-8).join("\n");
        } else {
          job.state = "succeeded";
          job.versionAfter = base.find((tool) => tool.tool === job.tool).latest;
          upgraded.add(job.tool);
        }
      } else {
        job.progress = script.lines[Math.min(script.lines.length - 1, Math.floor(elapsed / 900))];
      }
    }
    const running = [...jobs.values()].filter((job) => job.state === "running").length;
    let free = LIMIT - running;
    for (const job of list) {
      if (free <= 0) break;
      if (job.state !== "queued") continue;
      job.state = "running";
      job.runAt = now();
      free -= 1;
    }
  };
  /** 接口返回的任务：去掉替身自己记的开跑时间 */
  const publicJob = (job) => {
    const copy = { ...job };
    delete copy.runAt;
    return copy;
  };
  const latestJobs = () => {
    const byTool = new Map();
    for (const job of jobs.values()) byTool.set(job.tool, job);
    return [...byTool.values()].map(publicJob);
  };
  const tools = () =>
    [...base, ...missing].map((tool) =>
      upgraded.has(tool.tool) ? { ...tool, version: tool.latest, updateAvailable: false } : tool,
    );

  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    tick();
    if (path === "/api/local/agent-clis" && method === "GET") {
      const all = latestJobs();
      return json({ tools: tools(), job: all[0] ?? null, jobs: all });
    }
    if (path === "/api/local/agent-clis/current") {
      const all = latestJobs();
      return json({ job: all[0] ?? null, jobs: all });
    }
    const start = /^\/api\/local\/agent-clis\/([a-z]+)\/(upgrade|install)$/.exec(path);
    if (start && method === "POST") {
      const tool = start[1];
      const active = [...jobs.values()].find(
        (job) => job.tool === tool && (job.state === "running" || job.state === "queued"),
      );
      if (active) return json({ error: "已经在安装或升级了，等它结束再试。" }, 409);
      const running = [...jobs.values()].filter((job) => job.state === "running").length;
      const info = base.find((item) => item.tool === tool);
      const job = {
        id: `job-${tool}-${jobs.size + 1}`,
        tool,
        action: start[2],
        command: JSON.parse(String(init.body ?? "{}")).command ?? "",
        state: running < LIMIT ? "running" : "queued",
        progress: "",
        startedAt: iso(now()),
        versionBefore: info?.version ?? null,
        runAt: now(),
      };
      jobs.set(job.id, job);
      return json({ job: publicJob(job), agents: info?.agents ?? [] }, 202);
    }
    const one = /^\/api\/local\/agent-clis\/jobs\/(.+)$/.exec(path);
    if (one) {
      const job = jobs.get(decodeURIComponent(one[1]));
      if (!job) return json({ error: "参数不正确。" }, 404);
      return json({ job: publicJob(job) });
    }
    return original(input, init);
  };
})();

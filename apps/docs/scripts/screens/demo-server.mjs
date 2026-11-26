// 文档配图用的演示 Server：临时目录里造一个演示仓库和演示数据，起一个只监听 127.0.0.1 的 Hive Server，
// 再让几位「假成员」经真实协议上线、发消息、提问、上报执行过程，界面上看到的就是平时的样子。
//
// 由 screens.mjs 用 tsx 拉起（要直接导入 Server 源码），不单独运行。就绪后在标准输出打一行
// `DEMO_READY <json>`；收到 SIGTERM 后关掉 Server 并删除临时目录。
//
// 不碰真实数据：HOME、数据库、仓库都在临时目录里；不注入 IM 驱动、不阻止睡眠、本机 Agent 只用假进程；
// Agent CLI 检测用临时 HOME 里的假命令，最新版本也是写死的演示数据，不联网。
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SERVER = path.join(ROOT, "apps/server");
const HOME = process.env.HOME;
if (!HOME || !process.env.HIVE_DEMO_ROOT || path.resolve(HOME) !== process.env.HIVE_DEMO_ROOT)
  throw new Error("demo-server 要由 screens.mjs 拉起：HOME 必须是临时演示目录");

const { buildApp } = await import(path.join(SERVER, "src/app.ts"));
const { HiveDatabase } = await import(path.join(SERVER, "src/database.ts"));
const { AgentCliManager } = await import(path.join(SERVER, "src/agent-clis.ts"));
const { WorktreeManager } = await import(path.join(SERVER, "src/worktrees.ts"));
const { IncidentStore } = await import(path.join(SERVER, "src/incident-store.ts"));
const require = createRequire(path.join(SERVER, "package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/* ---------------- 演示数据 ---------------- */

/** 当前身份（截图时网页以这个身份进入）；房主 */
export const OWNER = "荣顶";

const AGENTS = {
  claude: { provider: "claude", persona: "架构设计与代码 review" },
  "claude-2": { provider: "claude", persona: "前端页面与交互" },
  "claude-3": { provider: "claude", persona: "补测试与回归检查" },
  codex: { provider: "codex", persona: "写代码、修 bug、补测试" },
  omp: { provider: "omp", persona: "运维脚本与环境巡检" },
  opencode: { provider: "opencode", persona: "文档与小改动" },
  gemini: { provider: "gemini", persona: "查资料与方案对比" },
  agy: { provider: "agy", persona: "页面走查与截图" },
  // 周屿电脑上的 Agent：从别的电脑接进来，不是本机 Agent，成员栏里没有「本机」标记
  "zhou-codex": { provider: "codex", persona: "周屿的电脑 · 接口联调", remote: true },
  "zhou-codex-2": { provider: "codex", persona: "周屿的电脑 · 跑 E2E 测试", remote: true },
};

/** 房间：名字、在线成员（人和 Agent）、离线的人；pinned 置顶 */
const ROOMS = [
  {
    id: "web",
    workspace: true,
    lead: "claude",
    pinned: true,
    humans: ["周屿"],
    offline: ["陈默"],
    // 成员栏里后上线的排在前面：倒着写，显示出来同类的挨在一起，周屿的两个在最后
    agents: [
      "zhou-codex-2",
      "zhou-codex",
      "omp",
      "opencode",
      "agy",
      "gemini",
      "codex",
      "claude-3",
      "claude-2",
      "claude",
    ],
  },
  { id: "design", pinned: true, humans: ["周屿"], agents: ["claude"] },
  // 还没有聊天记录的房间：截「提及成员」弹窗用，弹窗背后是空白
  { id: "api", humans: ["周屿"], agents: ["codex", "omp", "opencode", "claude"] },
  { id: "infra", humans: [], agents: ["omp"] },
  { id: "release", humans: ["陈默"], agents: [] },
  { id: "general", humans: ["周屿"], agents: ["claude"] },
];
const ARCHIVED_ROOMS = ["promo-618"];

/** 演示用 Agent CLI：版本、最新版、安装位置（相对临时 HOME） */
const CLIS = [
  {
    command: "claude",
    pkg: "@anthropic-ai/claude-code",
    version: "2.1.283 (Claude Code)",
    latest: "2.1.328",
  },
  { command: "codex", pkg: "@openai/codex", version: "codex-cli 0.162.1", latest: "0.170.0" },
  {
    command: "copilot",
    pkg: "@github/copilot",
    version: "GitHub Copilot CLI 1.0.114.",
    latest: "1.0.114",
  },
  { command: "opencode", pkg: "opencode-ai", version: "1.19.6", latest: "1.19.6" },
  {
    command: "omp",
    pkg: "@oh-my-pi/pi-coding-agent",
    version: "omp/18.15.0",
    latest: "19.0.0",
    bun: true,
  },
  {
    command: "gemini",
    pkg: "@google/gemini-cli",
    version: "0.21.3",
    latest: "0.23.0",
  },
  // agy 不在 npm 上：官方脚本装成 ~/.local/bin 里的单个程序
  { command: "agy", version: "1.6.2", native: true },
  {
    command: "openclaw",
    pkg: "openclaw",
    version: "OpenClaw 2026.5.7 (eeef486)",
    latest: "2026.11.5",
  },
];

/** claude 在 #design 交付的规范（附件） */
const PRICE_SPEC = `# 结算页金额显示规范

## 存储与计算

- 金额一律按**分**存成整数，计算过程中不出现小数。
- 只在显示时格式化，接口返回的也是分。

## 显示

| 场景 | 示例 | 写法 |
| --- | --- | --- |
| 普通金额 | ¥1,299.00 | \`formatPrice(129900)\` |
| 优惠、退款 | -¥20.00 | 负号放在货币符号前 |
| 免费 | ¥0.00 | 不写成「免费」，避免和活动文案混淆 |

- 千分位和货币符号统一用 \`Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })\`。
- 移动端和 PC 端共用 \`src/checkout/price.ts\` 里的 \`formatPrice\`，不各自手拼。

## 舍入

- 优惠分摊到每件商品时按分四舍五入，差额记到最后一件，合计和订单服务一致。

## 现在有出入的地方

1. 移动端结算页手拼「¥」+ \`toFixed(2)\`，没有千分位。
2. 订单详情页的优惠显示成「- ¥20」，少了小数位。
`;

/* ---------------- 临时 HOME 里的演示仓库与假 CLI ---------------- */

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "codex",
      GIT_AUTHOR_EMAIL: "codex@example.invalid",
      GIT_COMMITTER_NAME: "codex",
      GIT_COMMITTER_EMAIL: "codex@example.invalid",
    },
  }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createRepository() {
  const repo = path.join(HOME, "work/web");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  write(path.join(repo, "README.md"), "# web\n\n演示仓库。\n");
  write(
    path.join(repo, "src/checkout/price.ts"),
    "export const formatPrice = (cents: number) => `¥${(cents / 100).toFixed(2)}`;\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** 假的 Agent CLI：一个只会打印版本号的脚本，按 npm 全局安装（bun 安装、官方脚本安装）的目录结构放好 */
function createFakeClis() {
  const dirs = new Set();
  for (const cli of CLIS) {
    if (cli.native) {
      const bin = path.join(HOME, ".local/bin");
      write(path.join(bin, cli.command), `#!/bin/sh\necho "${cli.version}"\n`);
      fs.chmodSync(path.join(bin, cli.command), 0o755);
      dirs.add(bin);
      continue;
    }
    const prefix = path.join(HOME, cli.bun ? ".bun" : ".npm-global");
    const real = cli.bun
      ? path.join(prefix, "install/global/node_modules", cli.pkg, "bin", cli.command)
      : path.join(prefix, "lib/node_modules", cli.pkg, "bin", `${cli.command}.js`);
    write(real, `#!/bin/sh\necho "${cli.version}"\n`);
    fs.chmodSync(real, 0o755);
    const bin = path.join(prefix, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(real, path.join(bin, cli.command));
    dirs.add(bin);
    // 包管理器也放一个假的：升级按钮要找到安装它的 npm / bun 才出现（演示环境不会真的去升级）
    const manager = path.join(bin, cli.bun ? "bun" : "npm");
    if (!fs.existsSync(manager)) {
      write(manager, "#!/bin/sh\necho 10.9.0\n");
      fs.chmodSync(manager, 0o755);
    }
  }
  return [...dirs];
}

/* ---------------- 启动前直接写进数据库的部分 ---------------- */

/** 已合入可清理的任务目录；还在做的那条由 codex 在对话里经 MCP 建（见 playScenario），才会显示「有任务占用」 */
async function seedWorktrees(database, repo) {
  const room = "web";
  const codex = database.upsertParticipant({ roomId: room, username: "codex", type: "agent" });
  const manager = new WorktreeManager({ database, activeInvocations: () => [] });
  const merged = await manager.create(repo, codex, OWNER, [], { slug: "coupon-negative" });
  write(
    path.join(merged.worktree.path, "src/checkout/coupon.ts"),
    "export const applyCoupon = (total: number, off: number) => Math.max(0, total - off);\n",
  );
  git(merged.worktree.path, "add", ".");
  git(merged.worktree.path, "commit", "-q", "-m", "fix: 优惠券叠加后金额不再变负");
  git(
    repo,
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge feat/codex-coupon-negative",
    merged.worktree.branch,
  );
  // 这条已经做完：codex 之后的新任务不再沿用这个目录
  database.connection().prepare("DELETE FROM managed_worktree_focus").run();

  return { merged: merged.worktree };
}

/**
 * 白板：进展里能看到在做、卡住了、做完待验收、标灰（超过 1 天没更新）、已合入和里程碑。
 * 时间在写完后统一改到过去（见 backdate），界面显示「N 分钟前」。
 */
function seedWhiteboard(database, repo, worktrees) {
  const room = "web";
  const author = (name) =>
    database.upsertParticipant({ roomId: room, username: name, type: "agent" });
  const entries = [
    {
      by: "codex",
      age: 40 * MINUTE,
      input: {
        key: "price-rounding",
        slot: "blocked",
        summary: "结算页舍入口径等荣顶三选一，确认后 30 分钟内可提测",
        repo: "web",
        branch: "feat/codex-price-rounding",
      },
    },
    {
      by: "codex",
      age: 6 * MINUTE,
      input: {
        key: "mobile-price-format",
        slot: "in_progress",
        summary: "移动端结算页金额格式对齐 PC：千分位加货币符号",
      },
    },
    {
      by: "claude",
      age: 25 * MINUTE,
      input: {
        key: "login-rate-limit",
        slot: "ready",
        summary: "登录接口限流做完了，等 review",
        repo: "web",
        branch: "feat/claude-login-rate-limit",
      },
    },
    {
      by: "opencode",
      age: 2 * DAY + 3 * HOUR,
      input: {
        key: "home-analytics-sdk",
        slot: "in_progress",
        summary: "首页埋点迁移到新 SDK",
      },
    },
    {
      by: "codex",
      age: 3 * HOUR,
      input: {
        key: "coupon-negative",
        slot: "ready",
        summary: "优惠券叠加后金额变负的问题修好了",
        repo: "web",
        branch: worktrees.merged.branch,
      },
    },
    {
      by: "omp",
      age: 20 * HOUR,
      input: {
        key: "release-v2-3-check",
        slot: "milestone",
        summary: "v2.3 发布检查清单过完了，预发环境巡检正常",
      },
    },
    {
      by: "claude",
      age: 26 * HOUR,
      input: {
        key: "checkout-api-contract",
        slot: "milestone",
        summary: "结算接口契约定稿，前后端按 v2 字段联调",
      },
    },
  ];
  const ages = new Map();
  for (const { by, age, input } of entries) {
    const { entry } = database.upsertWhiteboardEntry(author(by), input);
    ages.set(entry.id, age);
  }
  const db = database.connection();
  const update = db.prepare(
    "UPDATE whiteboard_entries SET created_at = ?, updated_at = ? WHERE id = ?",
  );
  for (const [id, age] of ages) update.run(ago(age), ago(age), id);
  void repo;
}

/**
 * 故障面板：升级给人、待处理、修复中、已解决各一张「我们的问题」，一张外部原因，再加一条待批准的规则提议。
 * IncidentStore 用可拨的时钟写，出现时间、派修时间直接落在过去。
 */
function seedIncidents(database) {
  let clock = Date.now();
  const store = new IncidentStore(database.connection(), () => clock);
  const at = (age) => {
    clock = Date.now() - age;
    return new Date(clock).toISOString();
  };
  const record = (occurrence, ages) => {
    let incident;
    for (const age of ages) {
      const time = at(age);
      incident = store.record({
        ...occurrence,
        sample: { ...occurrence.sample, at: time },
      }).incident;
    }
    return incident;
  };
  const dispatch = (incident, attempt, agentName, age, outcome, reason) => {
    at(age);
    const item = store.addDispatch({
      incidentId: incident.id,
      attempt,
      roomId: "web",
      agentName,
    });
    if (outcome !== "pending") {
      at(age - 20 * MINUTE);
      store.updateDispatch(item.id, { outcome, reason });
    }
  };

  const stale = record(
    {
      origin: "internal",
      source: "invocation",
      fingerprint: "invocation:invocation.stale:codex",
      title: "codex · Bridge 报告这一轮已结束，Server 还在等它的结果",
      sample: {
        roomId: "web",
        agentName: "codex",
        provider: "codex",
        detail:
          "Bridge 报告这一轮已结束，Server 还在等它的结果；超过 10 分钟没有新进展，已标为卡住",
      },
    },
    [9 * HOUR, 6 * HOUR, 5 * HOUR, 3 * HOUR, 2 * HOUR, 70 * MINUTE, 50 * MINUTE],
  );
  dispatch(stale, 1, "claude", 5 * HOUR, "failed", "调用超时，没交修复");
  dispatch(stale, 2, "claude", 2 * HOUR, "failed", "修复合入后同一种错误又出现");
  at(50 * MINUTE);
  store.update(stale.id, {
    status: "escalated",
    failedAttempts: 2,
    noteText: { key: "incident.note.escalatedAttempts", params: { count: 2 } },
  });

  record(
    {
      origin: "internal",
      source: "server",
      fingerprint: "server:TypeError:worktrees.ts:listWorktrees",
      title: "TypeError: Cannot read properties of undefined (reading 'branch')",
      sample: {
        roomId: "web",
        route: "GET /api/local/worktrees/:roomId",
        detail: "Cannot read properties of undefined (reading 'branch')",
        stack:
          "TypeError: Cannot read properties of undefined (reading 'branch')\n    at listWorktrees (apps/server/src/worktrees.ts)\n    at handler (apps/server/src/local-routes.ts)",
      },
    },
    [4 * HOUR, 2 * HOUR],
  );

  const scroll = record(
    {
      origin: "internal",
      source: "web",
      fingerprint: "web:error:TypeError:message-list.tsx",
      title: "TypeError: Cannot read properties of null (reading 'scrollTop')",
      sample: {
        roomId: "web",
        detail: "Cannot read properties of null (reading 'scrollTop')",
        stack:
          "TypeError: Cannot read properties of null (reading 'scrollTop')\n    at onScroll (message-list.tsx)",
      },
    },
    [3 * HOUR, 2 * HOUR, 90 * MINUTE],
  );
  dispatch(scroll, 1, "claude", 85 * MINUTE, "pending");
  store.update(scroll.id, { status: "fixing" });

  const time = record(
    {
      origin: "internal",
      source: "server",
      fingerprint: "server:RangeError:schedules.ts:nextRun",
      title: "RangeError: Invalid time value",
      sample: {
        roomId: "infra",
        route: "POST /api/rooms/:roomId/schedules",
        detail: "Invalid time value",
      },
    },
    [DAY + 5 * HOUR, DAY + 4 * HOUR, DAY + 2 * HOUR],
  );
  at(20 * HOUR);
  store.update(time.id, { status: "resolved", resolvedAt: new Date(clock).toISOString() });

  record(
    {
      origin: "external",
      source: "invocation",
      fingerprint: "invocation:bridge.upstreamExhausted:omp",
      title: "omp · 上游模型服务出错：503 Service Unavailable",
      sample: {
        roomId: "infra",
        agentName: "omp",
        provider: "omp",
        detail: "上游模型服务出错：503 Service Unavailable（已自动重试 3 次）",
      },
    },
    [5 * HOUR, 3 * HOUR, 40 * MINUTE, 18 * MINUTE],
  );

  at(30 * MINUTE);
  store.addProposal({
    roomId: "web",
    agentName: "claude",
    text: "改动 WebSocket 事件的格式前，先跑 protocol 和 web 的全量测试",
    reason: "上次只跑了 server 测试，网页收到新事件后报协议校验失败",
  });
}

function seedDatabase(databasePath, repo) {
  const database = new HiveDatabase(databasePath);
  for (const room of ROOMS) {
    if (!database.getRoom(room.id)) database.createRoom({ id: room.id, createdBy: OWNER });
    database.updateRoom(room.id, {
      ...(room.workspace ? { workspace: repo } : {}),
      ...(room.lead ? { leadAgent: room.lead } : {}),
    });
    // 离线成员：来过这个房间，现在不在
    for (const name of room.offline ?? [])
      database.setParticipantStatus(
        database.upsertParticipant({ roomId: room.id, username: name, type: "human" }).id,
        "offline",
      );
  }
  // 除了周屿的两个，其余 Agent 都是这台电脑上的本机 Agent（进程是假的，见 buildApp 的 localAgents.spawn）：
  // 本机 Agent 才能建任务目录，成员栏里也和平时一样显示本机管理入口
  for (const [name, agent] of Object.entries(AGENTS).filter(([, agent]) => !agent.remote))
    database.createLocalAgent({
      name,
      provider: agent.provider,
      access: "workspace",
      cwd: repo,
      model: null,
    });
  for (const id of ARCHIVED_ROOMS) {
    database.createRoom({ id, createdBy: OWNER });
    database.updateRoom(id, { archived: true });
  }
  database.setSetting(
    "room-pins",
    JSON.stringify(ROOMS.filter((room) => room.pinned).map((room) => room.id)),
  );
  return database;
}

/* ---------------- 经真实协议上线的假成员 ---------------- */

class Member {
  constructor(url, token, room, name, type, agent) {
    this.url = url;
    this.token = token;
    this.room = room;
    this.name = name;
    this.type = type;
    this.agent = agent;
    this.events = [];
    this.waiters = new Set();
  }

  async connect() {
    this.socket = new WebSocket(this.url.replace(/^http/, "ws") + "/ws");
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`${this.name} 连不上`)), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      this.events.push(JSON.parse(String(event.data)));
      for (const waiter of this.waiters) waiter();
    });
    this.send({
      type: "participant.join",
      username: this.name,
      participantType: this.type,
      roomId: this.room,
      token: this.token,
      ...(this.agent ? { provider: this.agent.provider, persona: this.agent.persona } : {}),
    });
    await this.next((event) => event.type === "room.snapshot");
    // 心跳：不发的话超时后会被当成离线
    this.heartbeat = setInterval(() => this.send({ type: "presence.heartbeat" }), 10_000);
    return this;
  }

  send(event) {
    this.socket.send(JSON.stringify(event));
  }

  next(predicate, timeoutMs = 10_000) {
    const take = () => {
      const index = this.events.findIndex(predicate);
      return index < 0 ? undefined : this.events.splice(index, 1)[0];
    };
    const found = take();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name} 等待事件超时`));
      }, timeoutMs);
      const check = () => {
        const event = take();
        if (!event) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(event);
      };
      this.waiters.add(check);
    });
  }

  /** 发一条消息，返回服务端存下的那条 */
  async say(content, extra = {}) {
    const clientMessageId = randomUUID();
    this.send({ type: "message.send", clientMessageId, content, ...extra });
    const created = await this.next(
      (event) =>
        event.type === "message.created" && event.message.clientMessageId === clientMessageId,
    );
    return created.message;
  }

  /** Agent：等到被 @ 的那条消息 */
  async mentioned(match) {
    const event = await this.next((item) => item.type === "agent.mentioned" && match(item.message));
    return event.message;
  }

  report(messageId, status, extra = {}) {
    this.send({ type: "invocation.report", messageId, status, ...extra });
  }

  /** 像 Bridge 开工时那样查一下这条任务的工作目录：Server 据此认定它支持安全目录交接，才允许建任务目录 */
  async taskWorkspace(messageId) {
    const response = await fetch(`${this.url}/api/agent/worktree?messageId=${messageId}`, {
      headers: this.agentHeaders(),
    });
    if (!response.ok) throw new Error(`${this.name} 查任务目录失败：${await response.text()}`);
  }

  agentHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "X-Hive-Room": this.room,
      "X-Hive-Agent-Name": this.name,
    };
  }

  /** 像 Agent 交付文件那样先上传附件，返回附件 ID；发消息时带上 attachmentIds */
  async upload(name, content, type) {
    const form = new FormData();
    form.append("file", new Blob([content], { type }), name);
    const response = await fetch(`${this.url}/api/rooms/${this.room}/attachments`, {
      method: "POST",
      headers: this.agentHeaders(),
      body: form,
    });
    if (!response.ok) throw new Error(`${this.name} 上传附件失败：${await response.text()}`);
    return (await response.json()).id;
  }

  async mcp() {
    const transport = new StreamableHTTPClientTransport(new URL(`${this.url}/mcp`), {
      requestInit: { headers: this.agentHeaders() },
    });
    const client = new Client({ name: "hive-docs-demo", version: "0.1.0" });
    await client.connect(transport);
    return client;
  }

  close() {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}

/** 一段对话：人 @ Agent，Agent 开工、回复或提问；返回各条消息，之后统一改时间 */
async function playScenario(url, token) {
  const members = [];
  const join = async (room, name, type) => {
    const member = await new Member(url, token, room, name, type, AGENTS[name]).connect();
    members.push(member);
    return member;
  };
  const timeline = [];
  const at = (message, age) => timeline.push({ id: message.id, age });

  // 先让各房间的成员上线（房主「荣顶」由截图用的网页以这个身份进入，这里只临时代为发言）
  const online = {};
  for (const room of ROOMS) {
    for (const name of room.humans)
      online[`${room.id}:${name}`] = await join(room.id, name, "human");
    for (const name of room.agents)
      online[`${room.id}:${name}`] = await join(room.id, name, "agent");
  }
  const lin = await join("web", OWNER, "human");
  const linOps = await join("infra", OWNER, "human");
  const zhou = online["web:周屿"];
  const codex = online["web:codex"];
  const claude = online["web:claude"];
  const omp = online["infra:omp"];

  // web：claude 做完一件事的回复，作为聊天开头
  const kickoff = await lin.say("登录接口加个限流，同一个手机号 1 分钟最多 5 次。");
  at(kickoff, 95 * MINUTE);
  const kickoffTask = await claude.mentioned((message) => message.id === kickoff.id);
  claude.report(kickoffTask.id, "running");
  const done = await claude.say(
    "限流加好了：按手机号计数，1 分钟 5 次，超出返回 429 和剩余秒数；补了 6 个用例。分支 `feat/claude-login-rate-limit`，等 review。",
    { parentMessageId: kickoffTask.id },
  );
  claude.report(kickoffTask.id, "completed", { replyMessageId: done.id });
  at(done, 25 * MINUTE + 30_000);

  // codex 查舍入，查完向荣顶提问（等你回答）
  const rounding = await lin.say("@codex 结算页和订单详情页的金额对不上，帮我查一下两边的舍入。");
  at(rounding, 52 * MINUTE);
  const roundingTask = await codex.mentioned((message) => message.id === rounding.id);
  codex.report(roundingTask.id, "running");
  await codex.taskWorkspace(roundingTask.id);
  const client = await codex.mcp();
  const created = await client.callTool({
    name: "hive_worktree_create",
    arguments: { slug: "price-rounding" },
  });
  const worktreePath = created.structuredContent?.worktree?.path;
  if (created.isError || !worktreePath)
    throw new Error(`建任务目录失败：${JSON.stringify(created.content)}`);
  // 已经写好复现测试（提交了），实现还没改完（未提交）
  write(
    path.join(worktreePath, "src/checkout/price.test.ts"),
    "// 结算页和订单详情页的舍入要一致\n",
  );
  git(worktreePath, "add", ".");
  git(worktreePath, "commit", "-q", "-m", "test: 复现结算页舍入误差");
  write(path.join(worktreePath, "src/checkout/price.ts"), "// 待定：舍入口径\n");
  const asked = await client.callTool({
    name: "hive_ask_human",
    arguments: {
      clientMessageId: randomUUID(),
      question:
        "结算页舍入口径用哪一种？两个页面不一致：结算页用 toFixed(2)，有浮点误差；订单详情页先换算成分再四舍五入。我已在 worktree feat/codex-price-rounding 写好复现测试。",
      options: [
        "统一按分四舍五入（与订单服务一致）",
        "统一用银行家舍入（四舍六入五成双）",
        "前端不舍入，直接显示后端金额",
      ],
    },
  });
  if (asked.isError) throw new Error(`提问失败：${JSON.stringify(asked.content)}`);
  await client.close();
  codex.report(roundingTask.id, "completed");
  const question = asked.structuredContent?.message;
  if (question?.id) at(question, 40 * MINUTE);

  // 周屿让 codex 先看另一件事：codex 正在执行，上报执行过程
  const format = await zhou.say(
    "@codex 等荣顶定舍入口径的时候，先帮我看下移动端结算页的金额格式：千分位和货币符号跟 PC 端对齐。",
  );
  at(format, 37 * MINUTE);
  const formatTask = await codex.mentioned((message) => message.id === format.id);
  codex.report(formatTask.id, "running");
  codex.send({ type: "agent.typing", active: true });
  online["api:codex"].send({ type: "agent.typing", active: true });
  const started = Date.now() - 36 * MINUTE;
  const step = (offset) => new Date(started + offset * 1000).toISOString();
  codex.send({
    type: "invocation.trace",
    messageId: formatTask.id,
    steps: [
      {
        id: "t1",
        kind: "thinking",
        text: "先找两端格式化金额的地方",
        startedAt: step(0),
        endedAt: step(8),
      },
      {
        id: "t2",
        kind: "text",
        text: "先看移动端结算页现在怎么格式化金额，再和 PC 端对齐。",
        startedAt: step(9),
      },
      {
        id: "t3",
        kind: "tool",
        tool: "search",
        name: "rg",
        summary: "formatPrice",
        status: "ok",
        startedAt: step(10),
        endedAt: step(11),
      },
      {
        id: "t4",
        kind: "tool",
        tool: "read",
        name: "Read",
        summary: "src/mobile/checkout/Total.tsx",
        status: "ok",
        startedAt: step(12),
        endedAt: step(13),
      },
      {
        id: "t5",
        kind: "text",
        text: "PC 端用 Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })；移动端手拼「¥」+ toFixed(2)，没有千分位。改成共用 formatPrice。",
        startedAt: step(20),
      },
      {
        id: "t6",
        kind: "tool",
        tool: "write",
        name: "Edit",
        summary: "src/mobile/checkout/Total.tsx",
        status: "ok",
        startedAt: step(30),
        endedAt: step(31),
      },
      {
        id: "t7",
        kind: "tool",
        tool: "write",
        name: "Edit",
        summary: "src/checkout/price.ts",
        status: "ok",
        startedAt: step(40),
        endedAt: step(41),
      },
      {
        id: "t8",
        kind: "tool",
        tool: "command",
        name: "Bash",
        summary: "pnpm vitest run src/mobile/checkout",
        status: "running",
        startedAt: step(60),
      },
    ],
  });

  // infra：omp 上游出错中断，等你决定
  const restart = await linOps.say("@omp 重启预发环境的订单队列 worker，确认积压清空后告诉我。");
  at(restart, 18 * MINUTE);
  const restartTask = await omp.mentioned((message) => message.id === restart.id);
  omp.report(restartTask.id, "running");
  omp.report(restartTask.id, "failed", {
    detail: "上游模型服务出错：503 Service Unavailable（已自动重试 3 次）",
    runtimeEvent: { kind: "provider_error", code: 503 },
  });

  // design：claude 交付一份 Markdown 规范，截「预览停到右侧栏」用
  const linDesign = await join("design", OWNER, "human");
  const claudeDesign = online["design:claude"];
  const spec = await linDesign.say(
    "@claude 把结算页金额的显示规则整理成一页规范，前端和设计都按它来。",
  );
  at(spec, 30 * MINUTE);
  const specTask = await claudeDesign.mentioned((message) => message.id === spec.id);
  claudeDesign.report(specTask.id, "running");
  const specFile = await claudeDesign.upload("金额显示规范.md", PRICE_SPEC, "text/markdown");
  const delivered = await claudeDesign.say(
    "整理好了，见附件：金额统一按分存、显示时才格式化；千分位和货币符号用 Intl.NumberFormat，负数和优惠的写法也列了。有出入的地方在最后一节。",
    { parentMessageId: specTask.id, attachmentIds: [specFile] },
  );
  claudeDesign.report(specTask.id, "completed", { replyMessageId: delivered.id });
  at(delivered, 22 * MINUTE);

  await sleep(300);
  // 荣顶的临时连接退出，网页会以这个身份重新进来
  for (const owner of [lin, linOps, linDesign]) {
    owner.close();
    members.splice(members.indexOf(owner), 1);
  }
  return { members, timeline, runningTask: formatTask.id, startedAt: new Date(started) };
}

/** 把这段对话的时间挪到过去：消息、调用都按设定的「多久以前」改 */
function backdate(databasePath, scenario) {
  // 直接开库改：HiveDatabase 打开时会把所有成员重置为离线
  const Database = require("better-sqlite3");
  const db = new Database(databasePath);
  try {
    const message = db.prepare("UPDATE messages SET created_at = ? WHERE id = ?");
    const invocations = db.prepare(
      `UPDATE invocations SET created_at = ?, updated_at = ?,
        received_at = CASE WHEN received_at IS NULL THEN NULL ELSE ? END,
        started_at = CASE WHEN started_at IS NULL THEN NULL ELSE ? END,
        finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE ? END
      WHERE message_id = ?`,
    );
    for (const { id, age } of scenario.timeline) {
      const time = ago(age);
      message.run(time, id);
      const finished = ago(Math.max(age - 2 * MINUTE, 0));
      invocations.run(time, finished, time, time, finished, id);
    }
    db.prepare("UPDATE invocations SET started_at = ?, updated_at = ? WHERE message_id = ?").run(
      scenario.startedAt.toISOString(),
      new Date().toISOString(),
      scenario.runningTask,
    );
  } finally {
    db.close();
  }
}

/** 合入后白板条目自动转成「已合入」时间是检测到的那一刻，挪回 3 小时前，和对话里的先后对得上 */
function backdateMerged(databasePath) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath);
  try {
    const time = ago(3 * HOUR);
    db.prepare(
      "UPDATE whiteboard_entries SET merged_at = ?, updated_at = ? WHERE merged_at IS NOT NULL",
    ).run(time, time);
  } finally {
    db.close();
  }
}

/** 「已合入可清理」的提示要等 Server 定期检查任务目录（约 10 秒一次）后才有，等到了再开始截图 */
async function waitForCleanupNotice(url) {
  // 本机接口要带本机房主凭证，网页也是先从 /api/local/session 取
  const session = await (await fetch(`${url}/api/local/session`)).json();
  const headers = { "X-Hive-Owner": session.ownerToken ?? "" };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/local/worktrees/web`, { headers });
    if (!response.ok) throw new Error(`读任务目录失败：${await response.text()}`);
    if ((await response.json()).cleanupBatch) return;
    await sleep(1000);
  }
  throw new Error("等不到任务目录的可清理提示");
}

/* ---------------- 启动 ---------------- */

const dataDir = path.join(HOME, ".hive-data");
const databasePath = path.join(dataDir, "hive.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
const repo = createRepository();
const cliDirs = createFakeClis();
const seeded = seedDatabase(databasePath, repo);
const worktrees = await seedWorktrees(seeded, repo);
seedWhiteboard(seeded, repo, worktrees);
seedIncidents(seeded);
seeded.close();

const token = randomBytes(24).toString("hex");
const latest = Object.fromEntries(
  CLIS.filter((cli) => cli.pkg).map((cli) => [cli.pkg, cli.latest]),
);
const app = await buildApp({
  databasePath,
  token,
  staticDir: path.join(ROOT, "apps/web/dist"),
  keepAwake: false,
  imDrivers: {},
  // 故障单不去核对 SuperHive 自己仓库的提交：演示数据里不出现真实的代码版本
  incidentRepo: false,
  agentClis: new AgentCliManager({
    home: HOME,
    env: { PATH: [...cliDirs, "/usr/bin", "/bin"].join(":"), HOME },
    loginPath: async () => cliDirs.join(":"),
    extraDirs: [],
    fetchJson: async (url) => {
      const tags = /\/-\/package\/(.+)\/dist-tags$/.exec(url);
      if (tags) return { latest: latest[decodeURIComponent(tags[1])] };
      return {};
    },
    spawnUpgrade: () => {
      throw new Error("演示环境不升级");
    },
  }),
  localAgents: {
    cli: { command: "demo-agent", args: [] },
    serverUrl: "http://127.0.0.1",
    // 不真的拉起 Agent：在线的成员都是上面的假连接
    spawn: () => ({
      pid: 9_999_998,
      onOutput: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }),
    probe: async (command) => {
      const cli = CLIS.find((item) => item.command === command);
      return { installed: Boolean(cli), version: cli?.version ?? null };
    },
    listMcp: async () => [],
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const url = `http://127.0.0.1:${app.server.address().port}`;

let members = [];
const shutdown = async () => {
  for (const member of members) member.close();
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

const scenario = await playScenario(url, token);
members = scenario.members;
backdate(databasePath, scenario);
await waitForCleanupNotice(url);
backdateMerged(databasePath);
console.log(`DEMO_READY ${JSON.stringify({ url, owner: OWNER, home: HOME })}`);

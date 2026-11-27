// 宣传片用的演示 Server：和文档配图的演示环境（../screens/demo-server.mjs）同一套做法——临时 HOME、
// 临时数据库、演示仓库，只监听 127.0.0.1，成员都是经真实协议上线的假连接——但数据更多
// （8 个房间、12 个 Agent、4 个人），并且留了几段「现场戏」，录屏时由 record.mjs 触发：
//
//   delegate  林夏 @claude-1 派活 → claude-1 委派给 codex-1、copilot-1、opencode-1 → 回执 → 汇总
//   designs   林夏 @claude-2 要设计稿 → 回复带两张图 → 问林夏选哪版 → 林夏点选后接着做
//   im        飞书扫码：假的飞书驱动，二维码内容是 example.com 的演示地址，不连任何真实账号
//
// 不碰真实数据：不注入真实 IM 驱动、本机 Agent 只用假进程、「用本机应用打开」等本机操作全换成空操作。
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
  throw new Error("promo/server.mjs 要由 make.mjs 拉起：HOME 必须是临时演示目录");

const { buildApp } = await import(path.join(SERVER, "src/app.ts"));
const { HiveDatabase } = await import(path.join(SERVER, "src/database.ts"));
const { AgentCliManager } = await import(path.join(SERVER, "src/agent-clis.ts"));
const require = createRequire(path.join(SERVER, "package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/* ---------------- 演示数据 ---------------- */

export const OWNER = "林夏";

/** 12 个 Agent：同一种开多个，分在两台电脑上 */
const AGENTS = {
  "claude-1": { provider: "claude", persona: "统筹、拆任务、review" },
  "claude-2": { provider: "claude", persona: "前端与设计稿" },
  "claude-3": { provider: "claude", persona: "接口与架构" },
  "codex-1": { provider: "codex", persona: "写代码、补测试" },
  "codex-2": { provider: "codex", persona: "修 bug" },
  "codex-3": { provider: "codex", persona: "数据脚本" },
  "copilot-1": { provider: "copilot", persona: "代码 review" },
  "copilot-2": { provider: "copilot", persona: "安全检查" },
  "omp-1": { provider: "omp", persona: "运维巡检" },
  "omp-2": { provider: "omp", persona: "压测与监控" },
  "opencode-1": { provider: "opencode", persona: "文档" },
  "opencode-2": { provider: "opencode", persona: "跑 CI" },
};

const ALL_AGENTS = Object.keys(AGENTS);

/** 8 个房间；web 是主舞台 */
const ROOMS = [
  {
    id: "web",
    name: "web",
    workspace: true,
    lead: "claude-1",
    pinned: true,
    humans: ["周屿", "许棠"],
    offline: ["陈默"],
    agents: ALL_AGENTS,
  },
  {
    id: "design",
    pinned: true,
    humans: ["许棠"],
    agents: ["claude-2", "opencode-1"],
  },
  { id: "payment", humans: ["周屿"], agents: ["claude-3", "codex-2", "copilot-2"] },
  { id: "mobile-app", humans: ["周屿"], agents: ["codex-1", "claude-2", "opencode-2"] },
  { id: "infra", humans: [], agents: ["omp-1", "omp-2"] },
  { id: "data-report", humans: ["陈默"], agents: ["codex-3"] },
  { id: "release", humans: ["陈默"], agents: ["opencode-2", "copilot-1"] },
  { id: "general", humans: ["周屿", "许棠"], agents: ["claude-1"] },
];

/** 演示用 Agent CLI：只会打印版本号的假命令，最新版本写死，不联网 */
const CLIS = [
  {
    command: "claude",
    pkg: "@anthropic-ai/claude-code",
    version: "2.1.328 (Claude Code)",
    latest: "2.1.328",
  },
  { command: "codex", pkg: "@openai/codex", version: "codex-cli 0.170.0", latest: "0.170.0" },
  {
    command: "copilot",
    pkg: "@github/copilot",
    version: "GitHub Copilot CLI 1.0.114.",
    latest: "1.0.114",
  },
  { command: "opencode", pkg: "opencode-ai", version: "1.19.6", latest: "1.19.6" },
  { command: "omp", pkg: "@oh-my-pi/pi-coding-agent", version: "omp/19.0.0", latest: "19.0.0" },
];

export function createFakeClis() {
  const bin = path.join(HOME, ".npm-global/bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const cli of CLIS) {
    const real = path.join(
      HOME,
      ".npm-global/lib/node_modules",
      cli.pkg,
      "bin",
      `${cli.command}.js`,
    );
    write(real, `#!/bin/sh\necho "${cli.version}"\n`);
    fs.chmodSync(real, 0o755);
    fs.symlinkSync(real, path.join(bin, cli.command));
  }
  write(path.join(bin, "npm"), "#!/bin/sh\necho 10.9.0\n");
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  return [bin];
}

/* ---------------- 演示仓库 ---------------- */

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "codex-1",
      GIT_AUTHOR_EMAIL: "codex-1@example.invalid",
      GIT_COMMITTER_NAME: "codex-1",
      GIT_COMMITTER_EMAIL: "codex-1@example.invalid",
    },
  }).trim();
}

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const PRICE_BEFORE = `// 结算页金额格式化
export function formatPrice(cents: number): string {
  return "¥" + (cents / 100).toFixed(2);
}

export function sumItems(items: { price: number; count: number }[]): number {
  let total = 0;
  for (const item of items) total += item.price * item.count;
  return total;
}
`;

const PRICE_AFTER = `// 结算页金额格式化：统一按分存整数，只在显示时格式化
const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });

export function formatPrice(cents: number): string {
  return currency.format(cents / 100);
}

/** 优惠按分四舍五入，差额记到最后一件，合计和订单服务一致 */
export function splitDiscount(items: { price: number; count: number }[], off: number): number[] {
  const total = sumItems(items);
  const shares = items.map((item) => Math.round((item.price * item.count * off) / total));
  shares[shares.length - 1] += off - shares.reduce((a, b) => a + b, 0);
  return shares;
}

export function sumItems(items: { price: number; count: number }[]): number {
  return items.reduce((total, item) => total + item.price * item.count, 0);
}
`;

const TOTAL_BEFORE = `import { sumItems } from "../../checkout/price";

export function Total({ items }) {
  const total = sumItems(items);
  return <div className="total">¥{(total / 100).toFixed(2)}</div>;
}
`;

const TOTAL_AFTER = `import { formatPrice, sumItems } from "../../checkout/price";

export function Total({ items, discount = 0 }) {
  const total = sumItems(items) - discount;
  return (
    <div className="total">
      {discount > 0 && <span className="total-off">已优惠 {formatPrice(discount)}</span>}
      <strong>{formatPrice(total)}</strong>
    </div>
  );
}
`;

function createRepository() {
  const repo = path.join(HOME, "work/web");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  write(path.join(repo, "README.md"), "# web\n\n演示仓库。\n");
  write(path.join(repo, "src/checkout/price.ts"), PRICE_BEFORE);
  write(path.join(repo, "src/mobile/checkout/Total.tsx"), TOTAL_BEFORE);
  write(path.join(repo, "src/checkout/Coupon.tsx"), "export const Coupon = () => null;\n");
  write(path.join(repo, "docs/checkout.md"), "# 结算页\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  write(
    path.join(repo, "src/checkout/api.ts"),
    "export const getCart = () => fetch('/api/cart');\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "feat: 购物车接口");
  return repo;
}

function seedDatabase(databasePath, repo) {
  const database = new HiveDatabase(databasePath);
  for (const room of ROOMS) {
    if (!database.getRoom(room.id)) database.createRoom({ id: room.id, createdBy: OWNER });
    database.updateRoom(room.id, {
      ...(room.workspace ? { workspace: repo } : {}),
      ...(room.lead ? { leadAgent: room.lead } : {}),
    });
    for (const name of room.offline ?? [])
      database.setParticipantStatus(
        database.upsertParticipant({ roomId: room.id, username: name, type: "human" }).id,
        "offline",
      );
  }
  for (const [name, agent] of Object.entries(AGENTS))
    database.createLocalAgent({
      name,
      provider: agent.provider,
      access: "workspace",
      cwd: repo,
      model: null,
    });
  database.setSetting(
    "room-pins",
    JSON.stringify(ROOMS.filter((room) => room.pinned).map((room) => room.id)),
  );
  return database;
}

/* ---------------- 经真实协议上线的假成员 ---------------- */

export class Member {
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
    this.heartbeat = setInterval(() => this.send({ type: "presence.heartbeat" }), 10_000);
    return this;
  }

  send(event) {
    this.socket.send(JSON.stringify(event));
  }

  next(predicate, timeoutMs = 20_000) {
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

  async say(content, extra = {}) {
    const clientMessageId = randomUUID();
    this.send({ type: "message.send", clientMessageId, content, ...extra });
    const created = await this.next(
      (event) =>
        event.type === "message.created" && event.message.clientMessageId === clientMessageId,
    );
    return created.message;
  }

  async mentioned(match, timeoutMs) {
    const event = await this.next(
      (item) => item.type === "agent.mentioned" && match(item.message),
      timeoutMs,
    );
    return event.message;
  }

  report(messageId, status, extra = {}) {
    this.send({ type: "invocation.report", messageId, status, ...extra });
  }

  typing(active) {
    this.send({ type: "agent.typing", active });
  }

  /** 执行过程：按 id 合并，可以只发新增或变化的步骤 */
  trace(messageId, steps) {
    this.send({ type: "invocation.trace", messageId, steps });
  }

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
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(`${this.url}/mcp`), {
      requestInit: { headers: this.agentHeaders() },
    });
    const client = new Client({ name: "hive-promo-demo", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async tool(name, args) {
    const client = await this.mcp();
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
      throw new Error(`${this.name} 调 ${name} 失败：${JSON.stringify(result.content)}`);
    return result.structuredContent ?? {};
  }

  close() {
    clearInterval(this.heartbeat);
    this.client?.close().catch(() => undefined);
    this.socket.close();
  }
}

/** 执行过程的小工具：一步步往外推，像真的在跑 */
export function tracer(member, messageId) {
  const started = Date.now();
  let n = 0;
  const at = () => new Date().toISOString();
  return {
    think(text) {
      const id = `s${++n}`;
      member.trace(messageId, [{ id, kind: "thinking", text, startedAt: at(), endedAt: at() }]);
    },
    say(text) {
      member.trace(messageId, [{ id: `s${++n}`, kind: "text", text, startedAt: at() }]);
    },
    /** 工具调用：先 running，ms 后 ok */
    async tool(tool, name, summary, ms = 600) {
      const id = `s${++n}`;
      const startedAt = at();
      member.trace(messageId, [
        { id, kind: "tool", tool, name, summary, status: "running", startedAt },
      ]);
      await sleep(ms);
      member.trace(messageId, [
        { id, kind: "tool", tool, name, summary, status: "ok", startedAt, endedAt: at() },
      ]);
    },
    elapsed: () => Date.now() - started,
  };
}

/* ---------------- 开场前的历史对话 ---------------- */

async function seedConversation(url, token, repo, images) {
  const members = new Map();
  const join = async (room, name, type) => {
    const member = await new Member(url, token, room, name, type, AGENTS[name]).connect();
    members.set(`${room}:${name}`, member);
    return member;
  };
  for (const room of ROOMS) {
    for (const name of room.humans) await join(room.id, name, "human");
    for (const name of room.agents) await join(room.id, name, "agent");
  }
  const owners = {};
  for (const room of ROOMS) owners[room.id] = await join(room.id, OWNER, "human");
  const m = (room, name) => members.get(`${room}:${name}`);
  const timeline = [];
  const at = (message, age) => message?.id && timeline.push({ id: message.id, age });

  /** 一问一答：人 @Agent，Agent 回复（可带附件） */
  const exchange = async (
    room,
    from,
    agent,
    ask,
    answer,
    { age, attachments = [], before } = {},
  ) => {
    const human = from === OWNER ? owners[room] : m(room, from);
    const asked = await human.say(ask);
    at(asked, age);
    const bot = m(room, agent);
    const task = await bot.mentioned((message) => message.id === asked.id);
    bot.report(task.id, "running");
    await before?.(bot, task);
    const ids = [];
    for (const file of attachments) ids.push(await bot.upload(file.name, file.content, file.type));
    const reply = await bot.say(answer, { parentMessageId: task.id, attachmentIds: ids });
    bot.report(task.id, "completed", { replyMessageId: reply.id });
    at(reply, age - 2 * MINUTE);
    return { asked, task, reply };
  };

  // 其他房间：各有一两条，侧栏有预览
  await exchange(
    "payment",
    "周屿",
    "claude-3",
    "@claude-3 分账接口的幂等键怎么设计？",
    "用「订单号 + 分账批次号」做幂等键，重复请求直接返回第一次的结果；草案已写进 docs/split.md。",
    { age: 3 * HOUR },
  );
  await exchange(
    "infra",
    OWNER,
    "omp-1",
    "@omp-1 看一下预发环境的磁盘和队列积压。",
    "预发三台机器磁盘都在 60% 以下，订单队列积压 0，告警规则正常。",
    { age: 2 * HOUR },
  );
  await exchange(
    "mobile-app",
    "周屿",
    "codex-1",
    "@codex-1 iOS 结算页的金额也对齐一下 PC。",
    "收到，和 web 那边共用 formatPrice，改完一起提测。",
    { age: 70 * MINUTE },
  );
  await exchange(
    "data-report",
    "陈默",
    "codex-3",
    "@codex-3 出一份上周的转化漏斗。",
    "漏斗见附件：加购到下单的转化 41.2%，比前一周高 3.1 个点。",
    {
      age: 5 * HOUR,
      attachments: [
        {
          name: "转化漏斗.csv",
          content: "步骤,人数\n浏览,12840\n加购,3920\n下单,1615\n支付,1502\n",
          type: "text/csv",
        },
      ],
    },
  );
  await exchange(
    "design",
    "许棠",
    "claude-2",
    "@claude-2 优惠券弹窗的空状态出一版文案。",
    "三版文案放在 docs/coupon-empty.md，推荐第二版：「还没有可用的优惠券，去逛逛吧」。",
    { age: 40 * MINUTE },
  );
  await exchange(
    "release",
    "陈默",
    "opencode-2",
    "@opencode-2 跑一下 v2.4 的发布前检查。",
    "CI 全绿，变更日志已生成，等你点发布。",
    { age: 25 * MINUTE },
  );
  await owners.general.say("下午 4 点结算页改版评审，大家把进展更新到白板上。");

  // web：主舞台的历史（按时间先后）
  const shop = "web";
  const board = (input) => async (bot) => bot.tool("hive_board_update", input);

  // 定时任务：经真实的 hive_schedule_create 建
  const schedules = [
    [
      "omp-1",
      "@omp-1 每天早上 9:30 汇总前一天的线上报错，发到房间里。",
      "每天 09:30 汇总线上报错",
      9,
      30,
      1440,
    ],
    ["codex-2", "@codex-2 每周一上午检查一次依赖升级。", "每周一 10:00 检查依赖升级", 10, 0, 10080],
    [
      "copilot-1",
      "@copilot-1 今晚 11 点在预发跑一遍结算回归。",
      "今晚 23:00 在预发跑结算回归",
      23,
      0,
      0,
    ],
    [
      "opencode-2",
      "@opencode-2 每天 18:00 把 CI 失败的用例整理一份。",
      "每天 18:00 整理 CI 失败用例",
      18,
      0,
      1440,
    ],
  ];
  for (const [index, [agent, ask, task, hour, minute, every]] of schedules.entries()) {
    await exchange(shop, OWNER, agent, ask, `好，已登记定时任务：${task}。`, {
      age: 6 * HOUR - index * 10 * MINUTE,
      before: async (bot) => {
        await bot.tool("hive_schedule_create", {
          runAt: nextTime(hour, minute),
          task,
          timeZone: "Asia/Shanghai",
          ...(every
            ? { everyMinutes: every, until: new Date(Date.now() + 28 * 24 * HOUR).toISOString() }
            : {}),
        });
      },
    });
  }
  await exchange(
    shop,
    OWNER,
    "claude-3",
    "@claude-3 把结算页金额的显示规则整理成一页规范。",
    "规范见附件：金额统一按分存、显示时才格式化，千分位和货币符号用 Intl.NumberFormat。",
    {
      age: 3 * HOUR,
      attachments: [{ name: "金额显示规范.md", content: images.spec, type: "text/markdown" }],
      before: board({
        key: "price-spec",
        slot: "milestone",
        summary: "金额显示规范定稿，前端和设计都按它来",
      }),
    },
  );
  await exchange(
    shop,
    "周屿",
    "omp-2",
    "@omp-2 压一下结算接口，看看 P99。",
    "500 并发压了 10 分钟：P99 182ms，没有错误。报告见附件。",
    {
      age: 2 * HOUR,
      attachments: [{ name: "结算接口压测.png", content: images.loadtest, type: "image/png" }],
      before: board({
        key: "checkout-loadtest",
        slot: "milestone",
        summary: "结算接口压测通过：500 并发 P99 182ms",
      }),
    },
  );
  await exchange(
    shop,
    "周屿",
    "codex-2",
    "@codex-2 优惠券叠加后金额会变负，看一下。",
    "复现了：两张满减券叠加时没有下限。正在补边界用例，修好后交 copilot-1 review。",
    {
      age: 80 * MINUTE,
      before: board({
        key: "coupon-negative",
        slot: "in_progress",
        summary: "优惠券叠加后金额变负，正在补边界用例",
      }),
    },
  );
  // codex-1 在自己的任务线上改金额格式：有提交、有未提交的改动，代码面板里看得到 diff
  await exchange(
    shop,
    OWNER,
    "codex-1",
    "@codex-1 结算页金额统一用 formatPrice，优惠分摊也一起做了。",
    "改好了，分支 `feat/codex-1-price-format`：formatPrice 换成 Intl.NumberFormat，加了 splitDiscount；移动端合计也接上了，测试在补。",
    {
      age: 50 * MINUTE,
      attachments: [{ name: "price.ts", content: PRICE_AFTER, type: "text/plain" }],
      before: async (bot, task) => {
        await bot.taskWorkspace(task.id);
        const created = await bot.tool("hive_worktree_create", { slug: "price-format" });
        const dir = created.worktree?.path;
        if (!dir) throw new Error("建任务目录失败");
        write(path.join(dir, "src/checkout/price.ts"), PRICE_AFTER);
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "feat: formatPrice 改用 Intl.NumberFormat，加优惠分摊");
        write(path.join(dir, "src/mobile/checkout/Total.tsx"), TOTAL_AFTER);
        await bot.tool("hive_board_update", {
          key: "price-format",
          slot: "in_progress",
          summary: "结算页金额统一用 formatPrice，优惠分摊做完，测试在补",
          repo: "web",
          branch: "feat/codex-1-price-format",
        });
      },
    },
  );
  // 房间工作区里也留几处未提交的改动：代码按钮上有数字
  write(path.join(repo, "src/mobile/checkout/Total.tsx"), TOTAL_AFTER);
  write(path.join(repo, "src/checkout/price.ts"), PRICE_AFTER);

  // 周屿 和 claude-1 的一段闲聊作为开头，最近一条
  const latest = await m(shop, "周屿").say("结算页改版今天要拆下去，@林夏 你来派吧。");
  at(latest, 6 * MINUTE);

  // 其他房间里有几位一直在干活：侧栏能看到转圈，房间不是静止的
  const busy = [
    [
      "payment",
      "周屿",
      "codex-2",
      "@codex-2 分账接口补上幂等键和重放测试。",
      ["read", "Read", "src/split/api.ts"],
      ["command", "Bash", "pnpm vitest run src/split"],
    ],
    [
      "infra",
      OWNER,
      "omp-2",
      "@omp-2 盯一下预发的结算接口，压测期间看监控。",
      ["command", "Bash", "k6 run checkout.js"],
      ["read", "Read", "grafana/checkout.json"],
    ],
    [
      "mobile-app",
      "周屿",
      "opencode-2",
      "@opencode-2 iOS 包跑一遍 CI。",
      ["command", "Bash", "fastlane test"],
      ["read", "Read", "ci/ios.yml"],
    ],
  ];
  for (const [room, from, agent, ask, ...steps] of busy) {
    const human = from === OWNER ? owners[room] : m(room, from);
    const asked = await human.say(ask);
    at(asked, 3 * MINUTE);
    const bot = m(room, agent);
    const task = await bot.mentioned((message) => message.id === asked.id);
    bot.report(task.id, "running");
    bot.typing(true);
    const t = tracer(bot, task.id);
    for (const [tool, name, summary] of steps) await t.tool(tool, name, summary, 50);
    t.say("还在跑，跑完把结果贴上来。");
  }

  for (const owner of Object.values(owners)) owner.close();
  return { members, timeline };
}

/** 下一个 hour:minute（上海时间），至少在一分钟以后 */
function nextTime(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  // 演示环境的 TZ 是 Asia/Shanghai，直接按本地时间算
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() < now.getTime() + 2 * MINUTE) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

/** 把历史对话挪到过去 */
function backdate(databasePath, seeded) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath);
  try {
    const message = db.prepare("UPDATE messages SET created_at = ? WHERE id = ?");
    for (const { id, age } of seeded.timeline) message.run(ago(age), id);
  } finally {
    db.close();
  }
}

/* ---------------- 现场戏 ---------------- */

export function scenes(members) {
  const m = (name, room = "web") => members.get(`${room}:${name}`);

  /** 委派：林夏的消息由网页发出；这里只演 Agent 这边 */
  async function delegate() {
    const lead = m("claude-1");
    const task = await lead.mentioned((message) => message.content.includes("结算页改版"), 120_000);
    lead.report(task.id, "running");
    lead.typing(true);
    const t = tracer(lead, task.id);
    t.think("改版涉及金额格式、优惠明细接口和文档，三块可以并行");
    await sleep(500);
    await t.tool("read", "Read", "docs/checkout.md", 450);
    t.say("拆成三路：codex-1 改移动端金额，copilot-1 review 优惠明细接口，opencode-1 更新文档。");
    await sleep(700);
    await lead.tool("hive_board_update", {
      key: "checkout-revamp",
      slot: "in_progress",
      summary: "结算页改版拆成三路并行：金额格式、优惠明细接口、文档",
    });
    const subtasks = [
      {
        agent: "codex-1",
        task: "移动端结算页金额统一用 formatPrice，加上优惠明细，补单测。",
        steps: [
          ["search", "rg", "formatPrice"],
          ["write", "Edit", "src/mobile/checkout/Total.tsx"],
          ["command", "Bash", "pnpm vitest run src/checkout"],
        ],
        reply: "移动端改好了：合计和优惠都走 formatPrice，新增 8 个用例全部通过。",
        delay: 2400,
      },
      {
        agent: "copilot-1",
        task: "review 优惠明细接口：字段命名、负数和舍入的边界。",
        steps: [
          ["read", "Read", "src/checkout/api.ts"],
          ["read", "Read", "src/checkout/price.ts"],
        ],
        reply: "接口 review 完：建议 discount 字段统一用分，舍入差额记到最后一件，其余没问题。",
        delay: 3200,
      },
      {
        agent: "opencode-1",
        task: "更新结算页文档和变更说明。",
        steps: [["write", "Edit", "docs/checkout.md"]],
        reply: "文档更新好了：补了金额显示规则和优惠明细的截图说明。",
        delay: 1800,
      },
    ];
    const delegations = [];
    for (const sub of subtasks) {
      const result = await lead.tool("hive_invoke", { agent: sub.agent, task: sub.task });
      delegations.push(result.messageId);
      await sleep(350);
    }
    lead.typing(false);
    // 派完这一轮就结束：结果靠回执回来
    lead.report(task.id, "completed");
    // 三个子任务并行跑
    await Promise.all(
      subtasks.map(async (sub, index) => {
        const bot = m(sub.agent);
        const job = await bot.mentioned((message) => message.id === delegations[index], 30_000);
        await sleep(sub.delay);
        bot.report(job.id, "running");
        bot.typing(true);
        const tr = tracer(bot, job.id);
        for (const [tool, name, summary] of sub.steps) await tr.tool(tool, name, summary, 1000);
        await sleep(sub.delay);
        bot.typing(false);
        const reply = await bot.say(sub.reply, { parentMessageId: job.id });
        bot.report(job.id, "completed", { replyMessageId: reply.id });
      }),
    );
    // 三张回执都回到 claude-1；最后一张到了再汇总
    const receipts = [];
    for (let i = 0; i < subtasks.length; i++)
      receipts.push(await lead.mentioned((message) => message.kind === "receipt", 30_000));
    for (const receipt of receipts.slice(0, -1)) {
      lead.report(receipt.id, "running");
      lead.report(receipt.id, "completed");
    }
    const final = receipts.at(-1);
    lead.report(final.id, "running");
    lead.typing(true);
    const tf = tracer(lead, final.id);
    tf.think("三路都交回了，汇总给林夏");
    await sleep(1200);
    await lead.tool("hive_board_update", {
      key: "checkout-revamp",
      slot: "ready",
      summary: "结算页改版三路都已交回，等林夏验收",
    });
    lead.typing(false);
    const summary = await lead.say(
      "@林夏 结算页改版三路都交回了：\n\n- **codex-1**：移动端金额和优惠明细，8 个新用例通过\n- **copilot-1**：优惠明细接口 review 完，建议已采纳\n- **opencode-1**：文档和变更说明已更新\n\n白板已更新为「待验收」。",
      { parentMessageId: final.id },
    );
    lead.report(final.id, "completed", { replyMessageId: summary.id });
  }

  /** 设计稿：带图回复 + 让林夏点选 + 选完接着做 */
  async function designs(images) {
    const bot = m("claude-2");
    const task = await bot.mentioned((message) => message.content.includes("设计稿"), 120_000);
    bot.report(task.id, "running");
    bot.typing(true);
    const t = tracer(bot, task.id);
    t.think("出两版：明细折叠 / 明细展开、合计吸底");
    await t.tool("write", "Write", "design/checkout-a.png", 700);
    await t.tool("write", "Write", "design/checkout-b.png", 700);
    const ids = [
      await bot.upload("结算页-方案A.png", images.designA, "image/png"),
      await bot.upload("结算页-方案B.png", images.designB, "image/png"),
    ];
    await bot.say(
      "两版设计稿见附件：**方案 A** 优惠明细折叠在合计下面；**方案 B** 明细展开、合计固定在底部。",
      // 不挂 parentMessageId：挂上就算这一轮的回复、调用随之结束，后面就没法再提问
      { attachmentIds: ids },
    );
    const asked = await bot.tool("hive_ask_human", {
      clientMessageId: randomUUID(),
      question: "结算页用哪一版？选好我就开工。",
      options: ["方案 A：明细折叠", "方案 B：明细展开、合计吸底", "两版都做，跑 A/B 测试"],
    });
    bot.typing(false);
    const questionId = asked.message?.id;
    const answer = await bot.mentioned(
      (message) =>
        Boolean(message.answer) || (questionId && message.replyToMessageId === questionId),
      180_000,
    );
    bot.report(answer.id, "running");
    bot.typing(true);
    const ta = tracer(bot, answer.id);
    ta.think("按方案 B 开工");
    await ta.tool("command", "Bash", "git switch -c feat/claude-2-checkout-b", 600);
    await ta.tool("write", "Edit", "src/checkout/Summary.tsx", 800);
    await bot.tool("hive_board_update", {
      key: "checkout-design-b",
      slot: "in_progress",
      summary: "结算页按方案 B 改版：明细展开、合计吸底",
    });
    bot.typing(false);
    const reply = await bot.say(
      "好，按**方案 B** 开工：明细展开、合计吸底。分支 `feat/claude-2-checkout-b`，白板已更新，预计 30 分钟后交 review。",
      { parentMessageId: answer.id },
    );
    bot.report(answer.id, "completed", { replyMessageId: reply.id });
  }

  /** 实时执行：一步步推执行过程，同时在白板上登记、做完改成待验收 */
  async function live() {
    const bot = m("codex-3");
    const task = await bot.mentioned((message) => message.content.includes("单元测试"), 120_000);
    bot.report(task.id, "running");
    bot.typing(true);
    const t = tracer(bot, task.id);
    t.think("先看 formatPrice 和 splitDiscount 现在有哪些用例");
    await sleep(700);
    await bot.tool("hive_board_update", {
      key: "price-tests",
      slot: "in_progress",
      summary: "金额格式化补单元测试，跑覆盖率",
    });
    await t.tool("search", "rg", "formatPrice|splitDiscount", 700);
    await t.tool("read", "Read", "src/checkout/price.ts", 700);
    t.say("现有用例只覆盖了正数，负数、零和优惠分摊的差额都没测。补 12 个用例。");
    await sleep(900);
    await t.tool("write", "Write", "src/checkout/price.test.ts", 900);
    await t.tool("command", "Bash", "pnpm vitest run src/checkout", 1800);
    t.say("12 个用例全部通过。");
    await sleep(600);
    await t.tool("command", "Bash", "pnpm vitest run --coverage src/checkout", 1800);
    await sleep(700);
    await bot.tool("hive_board_update", {
      key: "price-tests",
      slot: "ready",
      summary: "金额格式化单元测试补完：12 个用例，覆盖率 96%",
    });
    bot.typing(false);
    const reply = await bot.say(
      "补完了：`price.test.ts` 新增 12 个用例（负数、零、优惠分摊差额），全部通过；`src/checkout` 覆盖率 96%。",
      { parentMessageId: task.id },
    );
    bot.report(task.id, "completed", { replyMessageId: reply.id });
  }

  return { delegate, designs, live };
}

/* ---------------- 假的飞书驱动 ---------------- */

/** 扫码由录屏脚本控制节奏：调用 scan() 才算「扫了」，confirm() 才算「手机上确认」 */
function fakeFeishu() {
  let scanned;
  let confirmed;
  const scan = new Promise((resolve) => (scanned = resolve));
  const confirm = new Promise((resolve) => (confirmed = resolve));
  const driver = {
    channel: "feishu",
    maxTextLength: 4000,
    async login(callbacks) {
      // 二维码内容是演示地址，不指向任何真实的飞书应用
      callbacks.onQr("https://example.com/superhive-demo/feishu-login", 600);
      await scan;
      callbacks.onScanned();
      await confirm;
      return {
        ownerActorId: "ou_demo_owner",
        label: "SuperHive 助手（演示）",
        config: { appId: "cli_demo_app" },
        secret: "demo-secret",
        identityKey: "appId",
      };
    },
    createTransport() {
      return {
        async start(events) {
          events.onStatus("connected");
        },
        async sendText() {
          return undefined;
        },
        async close() {},
      };
    },
  };
  return { driver, scan: () => scanned(), confirm: () => confirmed() };
}

/* ---------------- 启动 ---------------- */

export async function startPromoServer({ images }) {
  const dataDir = path.join(HOME, ".hive-data");
  const databasePath = path.join(dataDir, "hive.sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  const repo = createRepository();
  // 「接入 Agent」的默认工作目录取 Server 进程的当前目录：切到演示仓库，界面上显示成 ~/work/web
  process.chdir(repo);
  seedDatabase(databasePath, repo).close();
  const cliDirs = createFakeClis();
  const latest = Object.fromEntries(CLIS.map((cli) => [cli.pkg, cli.latest]));

  const token = randomBytes(24).toString("hex");
  const feishu = fakeFeishu();
  const noop = async () => undefined;
  const app = await buildApp({
    databasePath,
    token,
    staticDir: path.join(ROOT, "apps/web/dist"),
    keepAwake: false,
    imDrivers: { feishu: feishu.driver },
    incidentRepo: false,
    // 邀请链接、接入命令里显示的地址
    publicUrl: "https://hive.example.com",
    openWithDefaultApp: noop,
    revealInFolder: noop,
    openTerminal: noop,
    agentClis: new AgentCliManager({
      home: HOME,
      env: { PATH: [...cliDirs, "/usr/bin", "/bin"].join(":"), HOME },
      loginPath: async () => cliDirs.join(":"),
      extraDirs: [],
      fetchJson: async (url) => {
        const tags = /\/-\/package\/(.+)\/dist-tags$/.exec(url);
        return tags ? { latest: latest[decodeURIComponent(tags[1])] } : {};
      },
      spawnUpgrade: () => {
        throw new Error("演示环境不升级");
      },
    }),
    localAgents: {
      cli: { command: "superhive", args: [] },
      serverUrl: "http://127.0.0.1",
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

  const seeded = await seedConversation(url, token, repo, images);
  backdate(databasePath, seeded);

  return {
    url,
    owner: OWNER,
    home: HOME,
    scenes: scenes(seeded.members),
    feishu,
    async stop() {
      for (const member of seeded.members.values()) member.close();
      await app.close().catch(() => undefined);
    },
  };
}

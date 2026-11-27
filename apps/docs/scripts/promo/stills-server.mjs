// 宣传截图用的演示 Server：和宣传片（server.mjs）同一套做法——临时 HOME、临时数据库、演示仓库，只监听
// 127.0.0.1，成员都是经真实协议上线的假连接——场景换成「一个功能从需求到上线」：
//
//   林夏在 #web 提「两步验证」→ 主 Agent claude-1 拆成四路，用 hive_invoke 派给 gemini-1（调研）、codex-1（后端）、
//   claude-2（前端）、copilot-1（安全 review）→ 中途 claude-2 提问、林夏点选回答 → 各自交回报告、设计稿和代码 →
//   回执回到 claude-1 汇总 → 林夏接着派 E2E（执行中）和部署预发（omp-1 在等林夏回答）。
//
// codex-1 的任务线里是真实的 git 提交，代码面板看到的是真的 diff。由 stills.mjs 用 tsx 拉起，就绪后在标准输出
// 打一行 `DEMO_READY <json>`；附件图片由 stills.mjs 先渲染好放在 $HOME/assets。
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { Member, createFakeClis, tracer, write } from "./server.mjs";
import { AUTH_FILES, REPORTS } from "./stills-assets.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SERVER = path.join(ROOT, "apps/server");
const HOME = process.env.HOME;

const { buildApp } = await import(path.join(SERVER, "src/app.ts"));
const { HiveDatabase } = await import(path.join(SERVER, "src/database.ts"));
const { AgentCliManager } = await import(path.join(SERVER, "src/agent-clis.ts"));
const require = createRequire(path.join(SERVER, "package.json"));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/* ---------------- 演示数据 ---------------- */

export const OWNER = "林夏";

const AGENTS = {
  "claude-1": { provider: "claude", persona: "统筹、拆任务、review" },
  "claude-2": { provider: "claude", persona: "前端页面与交互" },
  "codex-1": { provider: "codex", persona: "后端接口、补测试" },
  "codex-2": { provider: "codex", persona: "E2E 测试、修 bug" },
  "copilot-1": { provider: "copilot", persona: "代码与安全 review" },
  "gemini-1": { provider: "gemini", persona: "查资料、方案对比" },
  "opencode-1": { provider: "opencode", persona: "文档与变更说明" },
  "omp-1": { provider: "omp", persona: "部署与环境巡检" },
  // 周屿电脑上的 Agent：从别的电脑接进来，不是本机 Agent
  "zhou-codex": { provider: "codex", persona: "周屿的电脑 · 接口联调", remote: true },
};

const ROOMS = [
  {
    id: "web",
    workspace: true,
    lead: "claude-1",
    pinned: true,
    humans: ["周屿", "许棠"],
    offline: ["陈默"],
    // 成员栏里后上线的排在前面：倒着写
    agents: [
      "zhou-codex",
      "omp-1",
      "opencode-1",
      "gemini-1",
      "copilot-1",
      "codex-2",
      "codex-1",
      "claude-2",
      "claude-1",
    ],
  },
  { id: "design", pinned: true, humans: ["许棠"], agents: ["claude-2", "opencode-1"] },
  { id: "payment", humans: ["周屿"], agents: ["codex-2", "copilot-1"] },
  { id: "mobile-app", humans: ["周屿"], agents: ["codex-1", "claude-2"] },
  { id: "infra", humans: [], agents: ["omp-1"] },
  { id: "data-report", humans: ["陈默"], agents: ["gemini-1"] },
  { id: "release", humans: ["陈默"], agents: ["opencode-1", "copilot-1"] },
  { id: "general", humans: ["周屿", "许棠"], agents: ["claude-1"] },
];

/* ---------------- 演示仓库 ---------------- */

const PEOPLE = {
  周屿: "zhouyu",
  "claude-1": "claude-1",
  "codex-1": "codex-1",
  "codex-2": "codex-2",
  "opencode-1": "opencode-1",
};

function git(cwd, author, ...args) {
  const email = `${PEOPLE[author] ?? author}@example.invalid`;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: email,
    },
  }).trim();
}

/** 按「多久以前」提交：最近提交里显示成几小时前、几天前 */
function commit(cwd, author, message, age, files = {}) {
  for (const [file, content] of Object.entries(files)) write(path.join(cwd, file), content);
  git(cwd, author, "add", ".");
  const date = ago(age);
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${PEOPLE[author] ?? author}@example.invalid`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${PEOPLE[author] ?? author}@example.invalid`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function createRepository() {
  const repo = path.join(HOME, "work/web");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "周屿", "init", "-q", "-b", "main");
  git(repo, "周屿", "config", "commit.gpgsign", "false");
  const day = 24 * HOUR;
  commit(repo, "周屿", "chore: 初始化项目", 21 * day, AUTH_FILES.base);
  commit(repo, "claude-1", "feat(auth): 登录接口按手机号限流，1 分钟最多 5 次", 3 * day, {
    "src/auth/rate-limit.ts": AUTH_FILES.rateLimit,
  });
  commit(repo, "codex-2", "fix(auth): 会话快过期时并发刷新令牌偶发 401", 2 * day, {
    "src/auth/session.ts": AUTH_FILES.session,
  });
  commit(repo, "opencode-1", "docs: 补充登录流程和错误码说明", 30 * HOUR, {
    "docs/auth.md": AUTH_FILES.docs,
  });
  commit(repo, "周屿", "chore: vitest 升级到 3.2", 20 * HOUR, {
    "package.json": AUTH_FILES.packageJson,
  });
  return repo;
}

/* ---------------- 启动前写进数据库的部分 ---------------- */

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
  for (const [name, agent] of Object.entries(AGENTS).filter(([, agent]) => !agent.remote))
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

/* ---------------- 对话 ---------------- */

let worktreeDir;

async function play(url, token, repo, assets) {
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
  /** 消息 id → 多久以前；没写的（委派、回执、提问等服务端代发的）按前一条往后排 */
  const ages = new Map();
  const at = (message, age) => message?.id && ages.set(message.id, age);
  const boardAges = new Map();
  const board = async (bot, input, age) => {
    await bot.tool("hive_board_update", input);
    boardAges.set(input.key, age);
  };

  /** 一问一答 */
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
    await before?.(bot);
    const ids = [];
    for (const file of attachments) ids.push(await bot.upload(file.name, file.content, file.type));
    const reply = await bot.say(answer, { parentMessageId: task.id, attachmentIds: ids });
    bot.report(task.id, "completed", { replyMessageId: reply.id });
    at(reply, age - 2 * MINUTE);
  };

  // 其他房间：各有一两条，侧栏有预览
  await exchange(
    "payment",
    "周屿",
    "copilot-1",
    "@copilot-1 review 一下分账接口的幂等处理。",
    "看完了：幂等键用「订单号 + 分账批次号」没问题；重放时返回第一次的结果，建议把 409 改成 200，详见 PR 评论。",
    { age: 5 * HOUR },
  );
  await exchange(
    "mobile-app",
    "周屿",
    "codex-1",
    "@codex-1 iOS 登录页也要接两步验证，先评估一下改动量。",
    "接口和 web 共用；iOS 端要加动态码输入页和备用码入口，估计半天，等 web 这边定稿后一起做。",
    { age: 3 * HOUR },
  );
  await exchange(
    "data-report",
    "陈默",
    "gemini-1",
    "@gemini-1 上周登录失败的原因分一下类。",
    "分好了：密码错误 71%，验证码过期 18%，限流 9%，其他 2%。明细见附件。",
    {
      age: 4 * HOUR,
      attachments: [
        {
          name: "登录失败分类.csv",
          content: "原因,次数\n密码错误,2841\n验证码过期,722\n限流,361\n其他,80\n",
          type: "text/csv",
        },
      ],
    },
  );
  await exchange(
    "release",
    "陈默",
    "opencode-1",
    "@opencode-1 整理 v2.6 的变更日志。",
    "变更日志已生成：新增 3 项、修复 7 项，两步验证这一项等合入后补上。",
    { age: 50 * MINUTE },
  );
  await owners.general.say("周五下午发 v2.6，两步验证是这一版的重点，进展大家更新到白板上。");

  /* ---- #web 主舞台 ---- */
  const web = "web";
  const lin = owners[web];
  const lead = m(web, "claude-1");

  await exchange(
    web,
    "周屿",
    "opencode-1",
    "@opencode-1 把登录和会话相关的接口整理成一页说明，后面两步验证接着往上补。",
    "整理好了，见附件：登录、刷新令牌、限流和错误码都在里面，最后留了「两步验证」一节待补。",
    {
      age: 3 * HOUR + 10 * MINUTE,
      attachments: [
        { name: "登录与会话接口说明.md", content: REPORTS.authDoc, type: "text/markdown" },
      ],
      before: async (bot) => {
        await board(
          bot,
          {
            key: "login-rate-limit",
            slot: "milestone",
            summary: "登录接口限流上线：同一手机号 1 分钟 5 次",
          },
          2 * 24 * HOUR,
        );
        await board(
          bot,
          {
            key: "session-refresh",
            slot: "milestone",
            summary: "并发刷新令牌偶发 401 修好了，预发观察 24 小时无复发",
          },
          22 * HOUR,
        );
      },
    },
  );

  const kickoff = await lin.say(
    "@claude-1 这周要上两步验证：用户在「安全设置」里用验证器 App 扫码绑定，之后登录要输 6 位动态码；同时生成 10 个一次性备用码，手机丢了也能登录。周五前上预发。",
  );
  at(kickoff, 2 * HOUR + 20 * MINUTE);
  const kickTask = await lead.mentioned((message) => message.id === kickoff.id);
  lead.report(kickTask.id, "running");
  const lt = tracer(lead, kickTask.id);
  lt.think("登录流程、设置页、安全要求三块能并行，库的选型先查清楚");
  await lt.tool("read", "Read", "src/auth/login.ts", 30);
  await lt.tool("read", "Read", "docs/auth.md", 30);
  await board(
    lead,
    {
      key: "two-factor",
      slot: "in_progress",
      summary: "两步验证拆成四路并行：调研、后端、前端、安全 review",
    },
    2 * HOUR,
  );
  // 这次不做、以后要做的记进待办
  await lead.tool("hive_todo_add", { title: "关闭两步验证时要求再输一次动态码" });
  await lead.tool("hive_todo_add", { title: "iOS / Android 登录页接入两步验证" });
  await lead.tool("hive_todo_add", { title: "备用码剩 2 个以下时提示重新生成" });
  const subtasks = [
    [
      "gemini-1",
      "对比 TOTP 的几种实现（自己写 RFC 6238 / otplib / speakeasy），从维护状态、体积和时钟偏差处理给个建议，写成一页报告。",
    ],
    [
      "codex-1",
      "后端：TOTP 生成与校验（±1 个时间窗）、10 个一次性备用码（哈希存储）、开启后登录要过第二步；补单测。用 hive_worktree_create 建任务线。",
    ],
    [
      "claude-2",
      "前端：安全设置里的绑定页（二维码 + 手动输入密钥 + 备用码）和登录时输入动态码的页面，按许棠的设计规范做，出两张截图。",
    ],
    [
      "copilot-1",
      "安全 review：密钥存储、动态码防爆破、备用码一次性、计时攻击，codex-1 交回后逐条核。",
    ],
  ];
  const delegations = {};
  for (const [agent, task] of subtasks) {
    const result = await lead.tool("hive_invoke", { agent, task });
    delegations[agent] = result.messageId;
  }
  const plan = await lead.say(
    "拆成四路，已经派出去了：\n\n1. **gemini-1** 调研 TOTP 实现，给选型建议\n2. **codex-1** 后端：动态码、备用码、登录第二步\n3. **claude-2** 前端：绑定页和动态码输入页\n4. **copilot-1** 安全 review\n\n进展记在白板 `two-factor`，四路交回后我汇总给你。",
    { parentMessageId: kickTask.id },
  );
  lead.report(kickTask.id, "completed", { replyMessageId: plan.id });
  at(plan, 2 * HOUR + 17 * MINUTE);

  const job = async (agent) => {
    const bot = m(web, agent);
    const task = await bot.mentioned((message) => message.id === delegations[agent]);
    bot.report(task.id, "running");
    return { bot, task, t: tracer(bot, task.id) };
  };

  // gemini-1：调研报告
  {
    const { bot, task, t } = await job("gemini-1");
    await t.tool("search", "WebFetch", "RFC 6238", 30);
    await t.tool("search", "WebSearch", "otplib vs speakeasy maintenance", 30);
    const file = await bot.upload("TOTP 方案调研.md", REPORTS.research, "text/markdown");
    const reply = await bot.say(
      "调研好了，见附件。结论：**用 otplib**，RFC 6238 标准实现、仍在维护、tree-shake 后约 9 KB；speakeasy 已经 6 年没更新。时间窗建议 ±1（前后各 30 秒），足够覆盖手机时钟偏差。",
      { parentMessageId: task.id, attachmentIds: [file] },
    );
    bot.report(task.id, "completed", { replyMessageId: reply.id });
    at(reply, 2 * HOUR);
  }

  // 周屿插一句
  const zhou = await m(web, "周屿").say(
    "动态码校验的限流跟登录共用一套就行，别再单独加一张表。@codex-1",
  );
  at(zhou, 108 * MINUTE);
  {
    const zc = m(web, "codex-1");
    const ack = await zc.mentioned((message) => message.id === zhou.id);
    zc.report(ack.id, "running");
    const reply = await zc.say("好，第二步直接复用 `limitByPhone`，不加新表。", {
      parentMessageId: ack.id,
    });
    zc.report(ack.id, "completed", { replyMessageId: reply.id });
    at(reply, 106 * MINUTE);
  }

  // claude-2：做前端，中途提问，林夏点选回答后接着做，交回两张截图
  {
    const { bot, task, t } = await job("claude-2");
    t.think("备用码怎么交给用户会影响绑定页的流程，先问清楚");
    await t.tool("read", "Read", "src/settings/SecurityPage.tsx", 30);
    const asked = await bot.tool("hive_ask_human", {
      clientMessageId: randomUUID(),
      question: "绑定完成后，10 个备用码怎么交给用户？这会影响绑定页最后一步的设计。",
      options: [
        "只显示一次，勾选「我已保存」才能完成",
        "显示并提供下载 .txt",
        "两者都要：可下载，且勾选「我已保存」才能完成",
      ],
    });
    const question = { id: asked.questionMessageId };
    ages.set(question.id, 98 * MINUTE);
    // 提问后结束这一轮；林夏回答后另起一轮接着做
    bot.report(task.id, "completed");
    const answered = new Promise((resolve) =>
      bot
        .mentioned(
          (message) => Boolean(message.answer) || message.replyToMessageId === question.id,
          20_000,
        )
        .then(resolve),
    );
    lin.send({
      type: "question.answer",
      clientMessageId: randomUUID(),
      questionMessageId: question.id,
      selected: ["C"],
    });
    const answer = await answered;
    at(answer, 92 * MINUTE);
    bot.report(answer.id, "running");
    const ta = tracer(bot, answer.id);
    await ta.tool("write", "Edit", "src/settings/TwoFactorSetup.tsx", 30);
    await ta.tool("write", "Write", "src/auth/TotpPrompt.tsx", 30);
    await ta.tool("command", "Bash", "pnpm vitest run src/settings", 30);
    const ids = [
      await bot.upload("绑定两步验证.png", assets.setup, "image/png"),
      await bot.upload("登录-输入动态码.png", assets.prompt, "image/png"),
    ];
    await board(
      bot,
      {
        key: "two-factor-ui",
        slot: "ready",
        summary: "两步验证的绑定页和动态码输入页做完了，等 review",
        repo: "web",
        branch: "feat/claude-2-two-factor-ui",
      },
      62 * MINUTE,
    );
    const reply = await bot.say(
      "前端做完了，截图见附件：\n\n- **绑定页**：二维码旁边可以手动输入密钥；最后一步显示 10 个备用码，可下载，勾选「我已保存」才能完成\n- **登录第二步**：6 位输入框自动跳格、粘贴整串也能识别，底部能切换成备用码\n\n分支 `feat/claude-2-two-factor-ui`，组件测试 14 个通过。",
      { parentMessageId: answer.id, attachmentIds: ids },
    );
    bot.report(answer.id, "completed", { replyMessageId: reply.id });
    at(reply, 62 * MINUTE);
  }

  // 许棠看了截图提一句
  const tang = await m(web, "许棠").say(
    "绑定页的截图看过了，二维码再大一点，手动输入那行字号跟正文一致就行，其他没问题 👍 @claude-2",
  );
  at(tang, 55 * MINUTE);
  {
    const c2 = m(web, "claude-2");
    const ack = await c2.mentioned((message) => message.id === tang.id);
    c2.report(ack.id, "running");
    const reply = await c2.say(
      "改好了：二维码 168→200px，手动输入那行改成 14px，已推到同一分支。",
      {
        parentMessageId: ack.id,
      },
    );
    c2.report(ack.id, "completed", { replyMessageId: reply.id });
    at(reply, 52 * MINUTE);
  }

  // codex-1：后端，在任务线上真实提交
  {
    const { bot, task, t } = await job("codex-1");
    await bot.taskWorkspace(task.id);
    const created = await bot.tool("hive_worktree_create", { slug: "two-factor" });
    const dir = created.worktree?.path;
    if (!dir) throw new Error("建任务目录失败");
    worktreeDir = dir;
    await t.tool("read", "Read", "src/auth/login.ts", 30);
    await t.tool("write", "Write", "src/auth/totp.ts", 30);
    commit(dir, "codex-1", "feat(auth): TOTP 生成与校验（RFC 6238，±1 个时间窗）", 95 * MINUTE, {
      "src/auth/totp.ts": AUTH_FILES.totp,
    });
    commit(dir, "codex-1", "feat(auth): 10 个一次性备用码，只存哈希", 80 * MINUTE, {
      "src/auth/backup-codes.ts": AUTH_FILES.backupCodes,
    });
    commit(dir, "codex-1", "feat(auth): 开启两步验证后登录要过第二步", 68 * MINUTE, {
      "src/auth/login.ts": AUTH_FILES.loginAfter,
      "src/auth/session.ts": AUTH_FILES.sessionAfter,
    });
    commit(dir, "codex-1", "test(auth): 动态码、备用码和登录第二步补 32 个用例", 50 * MINUTE, {
      "src/auth/totp.test.ts": AUTH_FILES.totpTest,
    });
    // copilot-1 review 后的修改还没提交：代码面板上能看到未提交的改动
    write(path.join(dir, "src/auth/totp.ts"), AUTH_FILES.totpReviewed);
    await t.tool("command", "Bash", "pnpm vitest run src/auth", 30);
    await board(
      bot,
      {
        key: "two-factor-api",
        slot: "ready",
        summary: "两步验证后端做完了：动态码、备用码、登录第二步，32 个用例通过",
        repo: "web",
        branch: "feat/codex-1-two-factor",
      },
      45 * MINUTE,
    );
    const reply = await bot.say(
      "后端做完了，分支 `feat/codex-1-two-factor`：\n\n- `totp.ts`：RFC 6238，HMAC-SHA1 取 6 位，校验允许 ±1 个时间窗，比较用 `timingSafeEqual`\n- `backup-codes.ts`：10 个 `xxxx-xxxx`，只存 SHA-256，用过即作废\n- `login.ts`：开启后先发 5 分钟有效的待验证令牌，过了第二步才换正式会话；限流复用 `limitByPhone`\n\n`pnpm vitest run src/auth`：**32 passed**，覆盖率 96%。",
      { parentMessageId: task.id },
    );
    bot.report(task.id, "completed", { replyMessageId: reply.id });
    at(reply, 45 * MINUTE);
  }

  // copilot-1：安全 review
  {
    const { bot, task, t } = await job("copilot-1");
    await t.tool("read", "Read", "src/auth/totp.ts", 30);
    await t.tool("read", "Read", "src/auth/backup-codes.ts", 30);
    await t.tool("read", "Read", "src/auth/login.ts", 30);
    const file = await bot.upload("两步验证安全 review.md", REPORTS.review, "text/markdown");
    const reply = await bot.say(
      "安全 review 完，6 项通过、1 项要改（已和 codex-1 对过，改动在任务线上还没提交）：\n\n- ⚠️ 同一个动态码在 30 秒内能用两次 → 记下最后一次用过的时间窗，重复的拒绝\n\n报告见附件。",
      { parentMessageId: task.id, attachmentIds: [file] },
    );
    bot.report(task.id, "completed", { replyMessageId: reply.id });
    at(reply, 34 * MINUTE);
  }

  // 回执都回到 claude-1；最后一张汇总
  const receipts = [];
  for (let i = 0; i < subtasks.length; i++) {
    const receipt = await lead
      .mentioned((message) => message.kind === "receipt", 8_000)
      .catch(() => undefined);
    if (receipt) receipts.push(receipt);
  }
  if (!receipts.length) throw new Error("claude-1 没收到回执");
  for (const receipt of receipts.slice(0, -1)) {
    lead.report(receipt.id, "running");
    lead.report(receipt.id, "completed");
  }
  {
    const final = receipts.at(-1);
    lead.report(final.id, "running");
    await board(
      lead,
      {
        key: "two-factor",
        slot: "ready",
        summary: "两步验证四路都交回了，等林夏验收后合入、上预发",
      },
      28 * MINUTE,
    );
    const summary = await lead.say(
      "@林夏 两步验证四路都交回了，我 review 过：\n\n- **调研** gemini-1：参照 otplib 自己实现约 60 行，不加依赖\n- **后端** codex-1：32 个用例通过，覆盖率 96%\n- **前端** claude-2：绑定页、动态码页，许棠已过目\n- **安全** copilot-1：6 项通过，1 项已改（动态码防重放）\n\n建议：先合后端和前端两条分支，再让 codex-2 补一条端到端用例，然后上预发。",
      { parentMessageId: final.id },
    );
    lead.report(final.id, "completed", { replyMessageId: summary.id });
    at(summary, 26 * MINUTE);
  }

  // codex-2：E2E，正在跑
  const e2e = await lin.say(
    "可以，两条分支先合。@codex-2 补一条端到端：开启两步验证 → 退出 → 用动态码登录 → 用备用码登录。",
  );
  at(e2e, 14 * MINUTE);
  const e2eTask = await m(web, "codex-2").mentioned((message) => message.id === e2e.id);
  {
    const bot = m(web, "codex-2");
    bot.report(e2eTask.id, "running");
    bot.typing(true);
    const t = tracer(bot, e2eTask.id);
    t.think("先看现有的登录 E2E 怎么造用户，再写两步验证这条");
    await t.tool("read", "Read", "e2e/login.spec.ts", 30);
    await t.tool("write", "Write", "e2e/two-factor.spec.ts", 30);
    t.say("用固定密钥和假时钟生成动态码，不依赖真实时间；备用码用一次后再用应该被拒。");
    await board(
      bot,
      {
        key: "two-factor-e2e",
        slot: "in_progress",
        summary: "两步验证端到端用例在写：开启、动态码登录、备用码登录",
      },
      10 * MINUTE,
    );
    bot.trace(e2eTask.id, [
      {
        id: "e2e-run",
        kind: "tool",
        tool: "command",
        name: "Bash",
        summary: "pnpm playwright test e2e/two-factor.spec.ts",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    ]);
  }

  // omp-1：部署预发，在等林夏定时间
  const deploy = await lin.say("@omp-1 合进 main 后部署到预发，跑一遍登录冒烟。");
  at(deploy, 6 * MINUTE);
  {
    const bot = m(web, "omp-1");
    const task = await bot.mentioned((message) => message.id === deploy.id);
    bot.report(task.id, "running");
    const t = tracer(bot, task.id);
    await t.tool("command", "Bash", "kubectl -n staging get deploy web", 30);
    await board(
      bot,
      {
        key: "two-factor-staging",
        slot: "blocked",
        summary: "两步验证上预发在等林夏定部署时间",
        unblocks: ["two-factor"],
      },
      4 * MINUTE,
    );
    const asked = await bot.tool("hive_ask_human", {
      clientMessageId: randomUUID(),
      question: "预发现在有测试同学在跑支付回归（预计 18:30 结束）。什么时候部署？",
      options: ["现在部署，回归重跑一遍", "等回归跑完，18:30 后部署", "今晚 22:00 低峰时部署"],
    });
    ages.set(asked.questionMessageId, 4 * MINUTE);
    bot.report(task.id, "completed");
  }

  // 其他房间里也有人在干活：侧栏能看到转圈
  const busy = [
    [
      "payment",
      "周屿",
      "codex-2",
      "@codex-2 分账回调补上验签和重放测试。",
      "pnpm vitest run src/split",
    ],
    ["infra", OWNER, "omp-1", "@omp-1 预发证书月底到期，先续上。", "certbot renew --dry-run"],
  ];
  for (const [room, from, agent, ask, command] of busy) {
    const human = from === OWNER ? owners[room] : m(room, from);
    const asked = await human.say(ask);
    at(asked, 3 * MINUTE);
    const bot = m(room, agent);
    const task = await bot.mentioned((message) => message.id === asked.id);
    bot.report(task.id, "running");
    bot.typing(true);
    await tracer(bot, task.id).tool("command", "Bash", command, 30);
  }

  await sleep(300);
  for (const owner of Object.values(owners)) owner.close();
  return { members, ages, boardAges, runningTask: e2eTask.id };
}

/** 把对话挪到过去：写了时间的按设定，没写的（委派、回执、提问）排在前一条后面 */
function backdate(databasePath, played) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath);
  try {
    const rows = db.prepare("SELECT id, room_id FROM messages ORDER BY seq").all();
    const setMessage = db.prepare("UPDATE messages SET created_at = ? WHERE id = ?");
    const setInvocation = db.prepare(
      `UPDATE invocations SET created_at = ?, updated_at = ?,
        received_at = CASE WHEN received_at IS NULL THEN NULL ELSE ? END,
        started_at = CASE WHEN started_at IS NULL THEN NULL ELSE ? END,
        finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE ? END
      WHERE message_id = ?`,
    );
    const last = new Map();
    for (const row of rows) {
      const age =
        played.ages.get(row.id) ?? Math.max((last.get(row.room_id) ?? MINUTE) - 20_000, 0);
      last.set(row.room_id, age);
      const time = ago(age);
      setMessage.run(time, row.id);
      const finished = ago(Math.max(age - 90_000, 0));
      setInvocation.run(time, finished, time, time, finished, row.id);
    }
    // 正在执行的：从开工到现在一直在跑
    db.prepare("UPDATE invocations SET updated_at = ? WHERE status = 'running'").run(
      new Date().toISOString(),
    );
    const setBoard = db.prepare(
      "UPDATE whiteboard_entries SET created_at = ?, updated_at = ? WHERE key = ?",
    );
    for (const [key, age] of played.boardAges) setBoard.run(ago(age + 5 * MINUTE), ago(age), key);
    // 早些时候的里程碑，进展里不只有这一件事
    void played.runningTask;
  } finally {
    db.close();
  }
}

/* ---------------- 启动 ---------------- */

const dataDir = path.join(HOME, ".hive-data");
const databasePath = path.join(dataDir, "hive.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
const repo = createRepository();
process.chdir(repo);
seedDatabase(databasePath, repo).close();
const cliDirs = createFakeClis();
const assets = {
  setup: fs.readFileSync(path.join(HOME, "assets/setup.png")),
  prompt: fs.readFileSync(path.join(HOME, "assets/prompt.png")),
};

const token = randomBytes(24).toString("hex");
const noop = async () => undefined;
const app = await buildApp({
  databasePath,
  token,
  staticDir: path.join(ROOT, "apps/web/dist"),
  keepAwake: false,
  imDrivers: {},
  incidentRepo: false,
  publicUrl: "https://hive.example.com",
  openWithDefaultApp: noop,
  revealInFolder: noop,
  openTerminal: noop,
  agentClis: new AgentCliManager({
    home: HOME,
    env: { PATH: [...cliDirs, "/usr/bin", "/bin"].join(":"), HOME },
    loginPath: async () => cliDirs.join(":"),
    extraDirs: [],
    fetchJson: async () => ({}),
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
    probe: async () => ({ installed: true, version: "1.0.0" }),
    listMcp: async () => [],
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const url = `http://127.0.0.1:${app.server.address().port}`;

let members = new Map();
const shutdown = async () => {
  for (const member of members.values()) member.close();
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

const played = await play(url, token, repo, assets);
members = played.members;
backdate(databasePath, played);
// 终端里回放的 git log 用任务线上真实的提交号，和代码面板对得上
const log = git(worktreeDir, "codex-1", "log", "--format=%h%x09%s", "-4")
  .split("\n")
  .map((line) => line.split("\t"));
console.log(`DEMO_READY ${JSON.stringify({ url, owner: OWNER, home: HOME, log })}`);

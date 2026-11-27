// 首屏可交互演示（hero-demo.ts）的中英文案。只在大屏上按需加载，不进页面 HTML。人名、房间、文件都是演示数据。

export interface DemoMember {
  id: string;
  name: string;
  kind: "human" | "agent";
  role: string;
  /** 头像底色 */
  color: string;
  lead?: boolean;
  local?: boolean;
}

export interface DemoText {
  label: string;
  newRoom: string;
  search: string;
  mentions: string;
  tasks: string;
  incidents: string;
  needsYou: string;
  needs: { tag: string; tone: "ask" | "decide" | "incident"; text: string; go?: string }[];
  roomsTitle: string;
  rooms: { id: string; name: string; online: string }[];
  me: string;
  meNote: string;
  terminal: string;
  members: string;
  progress: string;
  local: string;
  lead: string;
  human: string;
  memberList: DemoMember[];
  board: { slot: string; items: { key: string; text: string; who: string }[] }[];
  boardDone: { key: string; text: string; who: string };
  composer: string;
  send: string;
  noMatch: string;
  status: {
    waiting: string;
    running: string;
    done: string;
    stopping: string;
    stopped: string;
    stop: string;
    details: string;
  };
  agentTag: string;
  api: {
    ask: string;
    question: string;
    options: string[];
    single: string;
    waiting: string;
    answered: string;
    zhou: string;
    claude2Steps: string[];
    claude2Reply: string;
    codexSteps: string[];
    codexReply: string;
    stoppedNote: string;
  };
  web: {
    ask: string;
    reply: string;
    file: string;
    fileMeta: string;
    previewTitle: string;
    previewBody: string;
    /** 「源码」那一页显示的 Markdown 原文，也是「下载」下到的内容 */
    source: string;
    size: string;
    view: string;
    raw: string;
    download: string;
    dock: string;
    undock: string;
    maximize: string;
    restore: string;
    close: string;
  };
  chat: { steps: string[]; reply: (agent: string) => string };
  term: {
    hint: string;
    unknown: (command: string) => string;
    ls: string;
    git: string;
    test: string[];
  };
  head: {
    rooms: string;
    side: string;
    topic: string;
    artifacts: string;
    code: string;
    share: string;
    cancel: string;
  };
  topic: { title: string; note: string };
  artifacts: {
    title: string;
    search: string;
    kinds: string;
    all: string;
    images: string;
    files: string;
    back: string;
    items: {
      name: string;
      kind: "image" | "file";
      meta: string;
      who: string;
      art?: "before" | "after";
    }[];
    imageNote: string;
    /** 产物里那两张「截图」上的数字 */
    badge: { before: string; after: string };
  };
  code: {
    title: string;
    branch: string;
    tabs: string[];
    against: string;
    summary: string;
    changes: {
      path: string;
      dir: string;
      flag: "A" | "M";
      add: number;
      del: number;
      diff: string[];
    }[];
    tree: { path: string; depth: number; dir?: boolean; body?: string }[];
    commits: { hash: string; text: string; who: string; when: string }[];
    pick: string;
  };
  share: {
    selected: (count: number) => string;
    all: string;
    copy: string;
    download: string;
    image: string;
    exit: string;
    copied: string;
    downloaded: string;
    imageNote: string;
    empty: string;
  };
  tips: Record<string, string>;
  now: string;
  elapsed: (seconds: number) => string;
}

const zhMembers: DemoMember[] = [
  { id: "rong", name: "荣顶", kind: "human", role: "Human", color: "#7c3aed" },
  {
    id: "codex",
    name: "codex",
    kind: "agent",
    role: "Codex · 写代码、修 bug、补测试",
    color: "#111827",
    local: true,
  },
  { id: "zhou", name: "周屿", kind: "human", role: "Human", color: "#10b981" },
  {
    id: "claude",
    name: "claude",
    kind: "agent",
    role: "Claude Code · 架构设计与代码 review",
    color: "#d97757",
    lead: true,
    local: true,
  },
  {
    id: "claude-2",
    name: "claude-2",
    kind: "agent",
    role: "Claude Code · 测试与 CI",
    color: "#d97757",
    local: true,
  },
  {
    id: "gemini",
    name: "gemini",
    kind: "agent",
    role: "Gemini CLI · 查资料与方案对比",
    color: "#4f7cff",
    local: true,
  },
  {
    id: "opencode",
    name: "opencode",
    kind: "agent",
    role: "OpenCode · 文档与小改动",
    color: "#334155",
    local: true,
  },
  {
    id: "omp",
    name: "omp",
    kind: "agent",
    role: "omp · 运维脚本与环境巡检",
    color: "#8b5cf6",
    local: true,
  },
  {
    id: "zhou-codex",
    name: "zhou-codex",
    kind: "agent",
    role: "Codex · 周屿的电脑 · 网关与联调",
    color: "#111827",
  },
];

const enMembers: DemoMember[] = [
  { id: "rong", name: "Rong", kind: "human", role: "Human", color: "#7c3aed" },
  {
    id: "codex",
    name: "codex",
    kind: "agent",
    role: "Codex · code, bug fixes, tests",
    color: "#111827",
    local: true,
  },
  { id: "zhou", name: "Zhou", kind: "human", role: "Human", color: "#10b981" },
  {
    id: "claude",
    name: "claude",
    kind: "agent",
    role: "Claude Code · design and code review",
    color: "#d97757",
    lead: true,
    local: true,
  },
  {
    id: "claude-2",
    name: "claude-2",
    kind: "agent",
    role: "Claude Code · tests and CI",
    color: "#d97757",
    local: true,
  },
  {
    id: "gemini",
    name: "gemini",
    kind: "agent",
    role: "Gemini CLI · research and options",
    color: "#4f7cff",
    local: true,
  },
  {
    id: "opencode",
    name: "opencode",
    kind: "agent",
    role: "OpenCode · docs and small fixes",
    color: "#334155",
    local: true,
  },
  {
    id: "omp",
    name: "omp",
    kind: "agent",
    role: "omp · ops scripts and checks",
    color: "#8b5cf6",
    local: true,
  },
  {
    id: "zhou-codex",
    name: "zhou-codex",
    kind: "agent",
    role: "Codex · Zhou's machine · gateway work",
    color: "#111827",
  },
];

const testOutput = [
  "",
  " RUN  v3.2.4 ~/work/api",
  "",
  " ✓ src/auth/refresh.test.ts (8 tests) 64ms",
  " ✓ src/auth/session.test.ts (5 tests) 22ms",
  " ✓ src/routes/login.test.ts (6 tests) 41ms",
  "",
  " Test Files  3 passed (3)",
  "      Tests  19 passed (19)",
];

export const demoText: Record<"zh-CN" | "en", DemoText> = {
  "zh-CN": {
    label: "SuperHive 可交互演示（演示数据）",
    newRoom: "新建房间",
    search: "搜索",
    mentions: "提及我",
    tasks: "Agent 任务",
    incidents: "故障",
    needsYou: "需要你处理",
    needs: [
      { tag: "等你回答", tone: "ask", text: "codex · # api", go: "question" },
      { tag: "等你决定", tone: "decide", text: "omp · # infra" },
      { tag: "故障单", tone: "incident", text: "codex · Bridge 报告这一轮…" },
    ],
    roomsTitle: "房间列表",
    rooms: [
      { id: "api", name: "api", online: "12 在线" },
      { id: "web", name: "web", online: "4 在线" },
      { id: "infra", name: "infra", online: "2 在线" },
      { id: "release", name: "release", online: "1 在线" },
    ],
    me: "荣顶",
    meNote: "当前身份",
    terminal: "终端",
    members: "成员",
    progress: "进展",
    local: "本机",
    lead: "主",
    human: "Human",
    memberList: zhMembers,
    board: [
      {
        slot: "进行中",
        items: [
          {
            key: "token-refresh-race",
            text: "登录偶发 401：并发刷新 token 互相作废，在查。",
            who: "codex",
          },
          { key: "e2e-flaky", text: "CI 上 e2e 偶发超时，查端口冲突。", who: "claude-2" },
        ],
      },
      {
        slot: "已就绪",
        items: [
          { key: "error-codes", text: "《API 错误码规范》已交付，前后端按它来。", who: "claude" },
        ],
      },
    ],
    boardDone: {
      key: "token-refresh-race",
      text: "同一用户的并发刷新合并成一次，已提交 3f9c2e1，测试 19/19 通过。",
      who: "codex",
    },
    composer: "发送消息，输入 @ 选择成员…",
    send: "发送",
    noMatch: "没有匹配的成员",
    status: {
      waiting: "等你回答",
      running: "进行中",
      done: "已完成",
      stopping: "停止中…",
      stopped: "已停止",
      stop: "停止",
      details: "详情",
    },
    agentTag: "Agent",
    api: {
      ask: "@codex 登录接口偶发 401，帮我查一下 token 刷新是不是有并发问题。",
      question:
        "@荣顶 查到了：两个请求同时发现 token 过期，会各刷新一次，后一次把前一次签发的 refresh token 作废，前一个请求就 401。修法选哪种？",
      options: [
        "同一用户的刷新合并成一次（singleflight）",
        "旧 refresh token 保留 30 秒宽限期",
        "服务端不动，让客户端串行刷新",
      ],
      single: "单选",
      waiting: "等你回答",
      answered: "已回答",
      zhou: "@claude-2 CI 上 e2e 偶发超时，帮我看看是不是端口冲突。",
      claude2Steps: [
        "读取 .github/workflows/ci.yml",
        "运行 pnpm test:e2e --repeat 20",
        "20 次里 3 次 EADDRINUSE :4000",
        "编辑 tests/e2e/setup.ts · 每个 worker 用随机端口",
        "运行 pnpm test:e2e --repeat 20",
        "20/20 通过",
      ],
      claude2Reply:
        "原因是几个 e2e worker 抢同一个 4000 端口。改成每个 worker 用随机端口，连跑 20 次全过。",
      codexSteps: [
        "读取 src/auth/refresh.ts",
        "编辑 src/auth/refresh.ts · 同一用户的刷新合并成一次",
        "新增 src/auth/refresh.test.ts · 并发 50 个请求",
        "运行 pnpm vitest run src/auth",
        "提交 3f9c2e1 fix(auth): 并发刷新 token 合并成一次",
      ],
      codexReply:
        "改好了：同一用户的并发刷新合并成一次，50 个并发请求不再 401。提交 3f9c2e1，测试 19/19 通过，已登记到白板。",
      stoppedNote: "这一轮已停止，已经做过的改动不会回滚。",
    },
    web: {
      ask: "@claude 把 API 的错误码整理成一页规范，前后端都按它来。",
      reply:
        "整理好了，见附件：错误统一返回 { code, message }，code 用大写常量；列了常用的几类和对应的 HTTP 状态，前端按 code 判断，不按文案。",
      file: "API 错误码规范.md",
      fileMeta: "1.2 KB · 点击预览",
      previewTitle: "API 错误码规范",
      previewBody:
        "<h4>返回格式</h4><ul><li>出错时统一返回 <code>{ code, message }</code>，<code>code</code> 是大写常量。</li><li>前端按 <code>code</code> 判断，<code>message</code> 只给人看。</li></ul><h4>常用错误码</h4><table><tr><th>code</th><th>HTTP</th><th>场景</th></tr><tr><td>AUTH_EXPIRED</td><td>401</td><td>token 过期，先刷新再重试</td></tr><tr><td>FORBIDDEN</td><td>403</td><td>没有权限</td></tr><tr><td>VALIDATION_FAILED</td><td>422</td><td>参数不合法</td></tr><tr><td>RATE_LIMITED</td><td>429</td><td>限流，按 Retry-After 重试</td></tr></table><h4>约定</h4><ul><li>新增错误码先改这份规范，再改代码。</li></ul>",
      source:
        "# API 错误码规范\n\n## 返回格式\n\n- 出错时统一返回 `{ code, message }`，`code` 是大写常量。\n- 前端按 `code` 判断，`message` 只给人看。\n\n## 常用错误码\n\n| code              | HTTP | 场景                     |\n| ----------------- | ---- | ------------------------ |\n| AUTH_EXPIRED      | 401  | token 过期，先刷新再重试 |\n| FORBIDDEN         | 403  | 没有权限                 |\n| VALIDATION_FAILED | 422  | 参数不合法               |\n| RATE_LIMITED      | 429  | 限流，按 Retry-After 重试 |\n\n## 约定\n\n- 新增错误码先改这份规范，再改代码。\n",
      size: "1.2 KB",
      view: "预览",
      raw: "源码",
      download: "下载",
      dock: "在右侧栏打开：一边看一边发消息",
      undock: "放大成弹窗",
      maximize: "放大预览",
      restore: "还原大小",
      close: "关闭预览",
    },
    chat: {
      steps: ["读取房间里的上下文", "思考中…"],
      reply: (agent) =>
        `收到。这是首页的演示，所以我只回这一句；真实使用时，${agent} 会在这个房间的工作区里动手，过程实时显示，你可以随时插话或停止。`,
    },
    term: {
      hint: "演示终端：试试 pnpm test、ls、git log",
      unknown: (command) => `zsh: 演示终端不认识「${command}」，试试 pnpm test、ls、git log`,
      ls: "README.md  package.json  pnpm-lock.yaml  src  tests  .github",
      git: "3f9c2e1 fix(auth): 并发刷新 token 合并成一次\n8a41d07 test(e2e): 每个 worker 用随机端口\nc5e7b92 docs: API 错误码规范",
      test: testOutput,
    },
    head: {
      rooms: "收起或展开房间列表",
      side: "收起或展开成员与白板",
      topic: "新话题",
      artifacts: "产物",
      code: "代码",
      share: "分享",
      cancel: "取消",
    },
    topic: { title: "新话题", note: "之前的消息不再作为 Agent 的上下文" },
    artifacts: {
      title: "产物",
      search: "搜索文件名",
      kinds: "类型",
      all: "全部",
      images: "图片",
      files: "文件",
      back: "返回",
      items: [
        { name: "API 错误码规范.md", kind: "file", meta: "1.2 KB · claude · #web", who: "claude" },
        {
          name: "登录-401-改前.png",
          kind: "image",
          meta: "186 KB · agy · #api",
          who: "agy",
          art: "before",
        },
        {
          name: "登录-401-改后.png",
          kind: "image",
          meta: "179 KB · agy · #api",
          who: "agy",
          art: "after",
        },
        {
          name: "e2e-repeat-20.log",
          kind: "file",
          meta: "3.4 KB · claude-2 · #api",
          who: "claude-2",
        },
      ],
      imageNote: "agy 在浏览器里连点 50 次登录，改前改后各截一张。",
      badge: { before: "401 × 7 / 50", after: "401 × 0 / 50" },
    },
    code: {
      title: "工作区",
      branch: "feat/codex-token-refresh",
      tabs: ["改动", "文件树", "最近提交"],
      against: "相对 main",
      summary: "1 个提交 · 3 个文件",
      changes: [
        {
          path: "src/auth/refresh.ts",
          dir: "src/auth",
          flag: "M",
          add: 6,
          del: 2,
          diff: [
            "@@ -12,9 +12,13 @@ export async function refreshToken(userId: string) {",
            "+const inflight = new Map<string, Promise<Tokens>>();",
            "+",
            " export async function refreshToken(userId: string) {",
            "-  const tokens = await issueTokens(userId);",
            "-  return tokens;",
            "+  // 同一用户同时只刷新一次，其余请求等同一个结果",
            "+  const pending = inflight.get(userId) ?? issueTokens(userId);",
            "+  inflight.set(userId, pending);",
            "+  return pending.finally(() => inflight.delete(userId));",
            " }",
          ],
        },
        {
          path: "src/auth/session.ts",
          dir: "src/auth",
          flag: "M",
          add: 1,
          del: 1,
          diff: [
            "@@ -30,6 +30,6 @@ export async function withSession(req: Request) {",
            "   if (isExpired(req.token)) {",
            "-    req.token = await issueTokens(req.userId);",
            "+    req.token = await refreshToken(req.userId);",
            "   }",
          ],
        },
        {
          path: "src/auth/refresh.test.ts",
          dir: "src/auth",
          flag: "A",
          add: 7,
          del: 0,
          diff: [
            "@@ -0,0 +1,7 @@",
            '+import { refreshToken } from "./refresh";',
            "+",
            '+test("50 个并发请求只刷新一次", async () => {',
            '+  const results = await Promise.all(range(50).map(() => refreshToken("u1")));',
            "+  expect(issueTokens).toHaveBeenCalledTimes(1);",
            "+  expect(new Set(results).size).toBe(1);",
            "+});",
          ],
        },
      ],
      tree: [
        { path: "src", depth: 0, dir: true },
        { path: "auth", depth: 1, dir: true },
        {
          path: "refresh.ts",
          depth: 2,
          body: "const inflight = new Map<string, Promise<Tokens>>();\n\nexport async function refreshToken(userId: string) {\n  const pending = inflight.get(userId) ?? issueTokens(userId);\n  inflight.set(userId, pending);\n  return pending.finally(() => inflight.delete(userId));\n}",
        },
        {
          path: "session.ts",
          depth: 2,
          body: "export async function withSession(req: Request) {\n  if (isExpired(req.token)) {\n    req.token = await refreshToken(req.userId);\n  }\n  return req;\n}",
        },
        { path: "routes", depth: 1, dir: true },
        {
          path: "login.ts",
          depth: 2,
          body: 'router.post("/login", async (req, res) => {\n  const user = await verify(req.body);\n  res.json(await issueTokens(user.id));\n});',
        },
        { path: "README.md", depth: 0, body: "# api\n\n演示仓库：登录、会话和 token 刷新。" },
        {
          path: "package.json",
          depth: 0,
          body: '{\n  "name": "api",\n  "scripts": { "test": "vitest run", "test:e2e": "playwright test" }\n}',
        },
      ],
      commits: [
        {
          hash: "3f9c2e1",
          text: "fix(auth): 并发刷新 token 合并成一次",
          who: "codex",
          when: "刚刚",
        },
        {
          hash: "8a41d07",
          text: "test(e2e): 每个 worker 用随机端口",
          who: "claude-2",
          when: "1 小时前",
        },
        { hash: "c5e7b92", text: "docs: API 错误码规范", who: "claude", when: "昨天" },
        { hash: "41be0aa", text: "chore: 升级 vitest 到 3.2", who: "omp", when: "3 天前" },
      ],
      pick: "选一个文件查看",
    },
    share: {
      selected: (count) => `已选 ${count} 条`,
      all: "全选",
      copy: "复制 Markdown",
      download: "下载 .md",
      image: "导出图片",
      exit: "退出",
      copied: "已复制到剪贴板",
      downloaded: "已下载",
      imageNote: "导出图片请在客户端里试",
      empty: "先点选几条消息",
    },
    tips: {
      artifacts: "房间里的图片和文件都在这",
      code: "看工作区的改动和文件",
      option: "点一个选项，回答 Agent",
      stop: "停止这一轮",
      composer: "输入 @ 选一个 Agent，发条消息",
      terminal: "打开内置终端",
      progress: "看看白板上的进展",
      room: "去 #web 看交回的成果",
      file: "点开文件，在右侧预览",
    },
    now: "刚刚",
    elapsed: (seconds) =>
      seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
  },
  en: {
    label: "Interactive SuperHive demo (demo data)",
    newRoom: "New room",
    search: "Search",
    mentions: "Mentions",
    tasks: "Agent tasks",
    incidents: "Incidents",
    needsYou: "Needs you",
    needs: [
      { tag: "Your answer", tone: "ask", text: "codex · # api", go: "question" },
      { tag: "Your call", tone: "decide", text: "omp · # infra" },
      { tag: "Incident", tone: "incident", text: "codex · Bridge reported…" },
    ],
    roomsTitle: "Rooms",
    rooms: [
      { id: "api", name: "api", online: "12 online" },
      { id: "web", name: "web", online: "4 online" },
      { id: "infra", name: "infra", online: "2 online" },
      { id: "release", name: "release", online: "1 online" },
    ],
    me: "Rong",
    meNote: "Current identity",
    terminal: "Terminal",
    members: "Members",
    progress: "Progress",
    local: "Local",
    lead: "Lead",
    human: "Human",
    memberList: enMembers,
    board: [
      {
        slot: "In progress",
        items: [
          {
            key: "token-refresh-race",
            text: "Random 401s on login: concurrent token refreshes revoke each other. Investigating.",
            who: "codex",
          },
          {
            key: "e2e-flaky",
            text: "e2e times out now and then in CI. Checking for port clashes.",
            who: "claude-2",
          },
        ],
      },
      {
        slot: "Ready",
        items: [
          {
            key: "error-codes",
            text: "API error code spec delivered for frontend and backend.",
            who: "claude",
          },
        ],
      },
    ],
    boardDone: {
      key: "token-refresh-race",
      text: "Concurrent refreshes per user now merge into one. Commit 3f9c2e1, tests 19/19.",
      who: "codex",
    },
    composer: "Send a message, type @ to pick a member…",
    send: "Send",
    noMatch: "No matching members",
    status: {
      waiting: "Waiting for you",
      running: "Running",
      done: "Done",
      stopping: "Stopping…",
      stopped: "Stopped",
      stop: "Stop",
      details: "Details",
    },
    agentTag: "Agent",
    api: {
      ask: "@codex login returns a 401 now and then. Can you check whether token refresh has a race?",
      question:
        "@Rong Found it: when two requests see an expired token at once, each refreshes, and the second revokes the refresh token the first just got, so the first request 401s. Which fix?",
      options: [
        "Merge concurrent refreshes per user (singleflight)",
        "Keep the old refresh token valid for 30 seconds",
        "Leave the server alone; serialize refreshes on the client",
      ],
      single: "Single choice",
      waiting: "Waiting for your answer",
      answered: "Answered",
      zhou: "@claude-2 e2e times out now and then in CI. Could it be a port clash?",
      claude2Steps: [
        "Read .github/workflows/ci.yml",
        "Run pnpm test:e2e --repeat 20",
        "3 of 20 runs hit EADDRINUSE :4000",
        "Edit tests/e2e/setup.ts · random port per worker",
        "Run pnpm test:e2e --repeat 20",
        "20/20 passed",
      ],
      claude2Reply:
        "Several e2e workers were fighting over port 4000. Each worker now gets a random port; 20 runs in a row pass.",
      codexSteps: [
        "Read src/auth/refresh.ts",
        "Edit src/auth/refresh.ts · merge refreshes per user",
        "Add src/auth/refresh.test.ts · 50 concurrent requests",
        "Run pnpm vitest run src/auth",
        "Commit 3f9c2e1 fix(auth): merge concurrent token refreshes",
      ],
      codexReply:
        "Done: concurrent refreshes per user merge into one, and 50 concurrent requests no longer 401. Commit 3f9c2e1, tests 19/19, logged on the whiteboard.",
      stoppedNote: "This turn was stopped. Changes already made are not rolled back.",
    },
    web: {
      ask: "@claude write up our API error codes as a one-page spec for frontend and backend.",
      reply:
        "Done, see the attachment: errors always return { code, message } with code as an uppercase constant; the common ones are listed with their HTTP status. Frontend branches on code, never on the message.",
      file: "api-error-codes.md",
      fileMeta: "1.2 KB · click to preview",
      previewTitle: "API error codes",
      previewBody:
        "<h4>Response shape</h4><ul><li>Errors always return <code>{ code, message }</code>; <code>code</code> is an uppercase constant.</li><li>Frontend branches on <code>code</code>; <code>message</code> is for people.</li></ul><h4>Common codes</h4><table><tr><th>code</th><th>HTTP</th><th>When</th></tr><tr><td>AUTH_EXPIRED</td><td>401</td><td>Token expired; refresh, then retry</td></tr><tr><td>FORBIDDEN</td><td>403</td><td>No permission</td></tr><tr><td>VALIDATION_FAILED</td><td>422</td><td>Invalid parameters</td></tr><tr><td>RATE_LIMITED</td><td>429</td><td>Throttled; retry after Retry-After</td></tr></table><h4>Rules</h4><ul><li>Add new codes to this spec first, then to the code.</li></ul>",
      source:
        "# API error codes\n\n## Response shape\n\n- Errors always return `{ code, message }`; `code` is an uppercase constant.\n- Frontend branches on `code`; `message` is for people.\n\n## Common codes\n\n| code              | HTTP | When                               |\n| ----------------- | ---- | ---------------------------------- |\n| AUTH_EXPIRED      | 401  | Token expired; refresh, then retry |\n| FORBIDDEN         | 403  | No permission                      |\n| VALIDATION_FAILED | 422  | Invalid parameters                 |\n| RATE_LIMITED      | 429  | Throttled; retry after Retry-After |\n\n## Rules\n\n- Add new codes to this spec first, then to the code.\n",
      size: "1.2 KB",
      view: "Preview",
      raw: "Source",
      download: "Download",
      dock: "Open in side panel: read while you chat",
      undock: "Open as dialog",
      maximize: "Enlarge preview",
      restore: "Restore size",
      close: "Close preview",
    },
    chat: {
      steps: ["Reading the room's context", "Thinking…"],
      reply: (agent) =>
        `Got it. This is the homepage demo, so this is all I'll say. For real, ${agent} would work in this room's workspace with every step shown live, and you could steer or stop at any time.`,
    },
    term: {
      hint: "Demo terminal: try pnpm test, ls, git log",
      unknown: (command) =>
        `zsh: the demo terminal doesn't know "${command}". Try pnpm test, ls, git log`,
      ls: "README.md  package.json  pnpm-lock.yaml  src  tests  .github",
      git: "3f9c2e1 fix(auth): merge concurrent token refreshes\n8a41d07 test(e2e): random port per worker\nc5e7b92 docs: API error code spec",
      test: testOutput,
    },
    head: {
      rooms: "Show or hide the room list",
      side: "Show or hide members and whiteboard",
      topic: "New topic",
      artifacts: "Artifacts",
      code: "Code",
      share: "Share",
      cancel: "Cancel",
    },
    topic: { title: "New topic", note: "Earlier messages are no longer agent context" },
    artifacts: {
      title: "Artifacts",
      search: "Search file names",
      kinds: "Type",
      all: "All",
      images: "Images",
      files: "Files",
      back: "Back",
      items: [
        { name: "api-error-codes.md", kind: "file", meta: "1.2 KB · claude · #web", who: "claude" },
        {
          name: "login-401-before.png",
          kind: "image",
          meta: "186 KB · agy · #api",
          who: "agy",
          art: "before",
        },
        {
          name: "login-401-after.png",
          kind: "image",
          meta: "179 KB · agy · #api",
          who: "agy",
          art: "after",
        },
        {
          name: "e2e-repeat-20.log",
          kind: "file",
          meta: "3.4 KB · claude-2 · #api",
          who: "claude-2",
        },
      ],
      imageNote: "agy hit login 50 times in the browser, before and after the fix.",
      badge: { before: "401 × 7 / 50", after: "401 × 0 / 50" },
    },
    code: {
      title: "Workspace",
      branch: "feat/codex-token-refresh",
      tabs: ["Changes", "Files", "Recent commits"],
      against: "vs main",
      summary: "1 commit · 3 files",
      changes: [
        {
          path: "src/auth/refresh.ts",
          dir: "src/auth",
          flag: "M",
          add: 6,
          del: 2,
          diff: [
            "@@ -12,9 +12,13 @@ export async function refreshToken(userId: string) {",
            "+const inflight = new Map<string, Promise<Tokens>>();",
            "+",
            " export async function refreshToken(userId: string) {",
            "-  const tokens = await issueTokens(userId);",
            "-  return tokens;",
            "+  // one refresh per user at a time; others await the same result",
            "+  const pending = inflight.get(userId) ?? issueTokens(userId);",
            "+  inflight.set(userId, pending);",
            "+  return pending.finally(() => inflight.delete(userId));",
            " }",
          ],
        },
        {
          path: "src/auth/session.ts",
          dir: "src/auth",
          flag: "M",
          add: 1,
          del: 1,
          diff: [
            "@@ -30,6 +30,6 @@ export async function withSession(req: Request) {",
            "   if (isExpired(req.token)) {",
            "-    req.token = await issueTokens(req.userId);",
            "+    req.token = await refreshToken(req.userId);",
            "   }",
          ],
        },
        {
          path: "src/auth/refresh.test.ts",
          dir: "src/auth",
          flag: "A",
          add: 7,
          del: 0,
          diff: [
            "@@ -0,0 +1,7 @@",
            '+import { refreshToken } from "./refresh";',
            "+",
            '+test("50 concurrent requests refresh once", async () => {',
            '+  const results = await Promise.all(range(50).map(() => refreshToken("u1")));',
            "+  expect(issueTokens).toHaveBeenCalledTimes(1);",
            "+  expect(new Set(results).size).toBe(1);",
            "+});",
          ],
        },
      ],
      tree: [
        { path: "src", depth: 0, dir: true },
        { path: "auth", depth: 1, dir: true },
        {
          path: "refresh.ts",
          depth: 2,
          body: "const inflight = new Map<string, Promise<Tokens>>();\n\nexport async function refreshToken(userId: string) {\n  const pending = inflight.get(userId) ?? issueTokens(userId);\n  inflight.set(userId, pending);\n  return pending.finally(() => inflight.delete(userId));\n}",
        },
        {
          path: "session.ts",
          depth: 2,
          body: "export async function withSession(req: Request) {\n  if (isExpired(req.token)) {\n    req.token = await refreshToken(req.userId);\n  }\n  return req;\n}",
        },
        { path: "routes", depth: 1, dir: true },
        {
          path: "login.ts",
          depth: 2,
          body: 'router.post("/login", async (req, res) => {\n  const user = await verify(req.body);\n  res.json(await issueTokens(user.id));\n});',
        },
        {
          path: "README.md",
          depth: 0,
          body: "# api\n\nDemo repository: login, sessions and token refresh.",
        },
        {
          path: "package.json",
          depth: 0,
          body: '{\n  "name": "api",\n  "scripts": { "test": "vitest run", "test:e2e": "playwright test" }\n}',
        },
      ],
      commits: [
        {
          hash: "3f9c2e1",
          text: "fix(auth): merge concurrent token refreshes",
          who: "codex",
          when: "just now",
        },
        {
          hash: "8a41d07",
          text: "test(e2e): random port per worker",
          who: "claude-2",
          when: "1 hour ago",
        },
        { hash: "c5e7b92", text: "docs: API error code spec", who: "claude", when: "yesterday" },
        { hash: "41be0aa", text: "chore: bump vitest to 3.2", who: "omp", when: "3 days ago" },
      ],
      pick: "Pick a file to view",
    },
    share: {
      selected: (count) => `${count} selected`,
      all: "Select all",
      copy: "Copy Markdown",
      download: "Download .md",
      image: "Export image",
      exit: "Exit",
      copied: "Copied to clipboard",
      downloaded: "Downloaded",
      imageNote: "Try image export in the app",
      empty: "Select a few messages first",
    },
    tips: {
      artifacts: "Every image and file in the room",
      code: "See workspace changes and files",
      option: "Pick an option to answer the agent",
      stop: "Stop this turn",
      composer: "Type @ to pick an agent and send a message",
      terminal: "Open the built-in terminal",
      progress: "See progress on the whiteboard",
      room: "Go to #web to see a delivered result",
      file: "Open the file in the side panel",
    },
    now: "now",
    elapsed: (seconds) =>
      seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
  },
};

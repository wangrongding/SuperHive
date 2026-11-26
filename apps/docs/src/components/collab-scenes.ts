// 首页协作模型图的两套演示数据：多人协作、一个人带多个 Agent 自闭环。
// 人名、Agent 名、任务和提交号都是演示数据。

export type AgentKind = "claude" | "codex" | "omp" | "opencode" | "copilot";
export type Status = "run" | "wait" | "ask" | "done";

export interface Scene {
  /** 页面内唯一，用来生成 aria 关联的 id */
  id: string;
  /** 醒目的类型标签，例如「多人协作」 */
  tag: string;
  title: string;
  /** 屏幕阅读器读到的整体说明 */
  description: string;
  room: string;
  /**
   * rows：电脑在上、房间在下（多人协作）；orbit：房间居中、Agent 环绕，左边是一个人和他的入口设备。
   */
  layout: "rows" | "orbit";
  /** orbit 用：这个人手里能指挥 Agent 的入口，也是连线的端点 */
  devices?: { node: string; name: string; kind: "phone" | "desktop"; role: string }[];
  /** node 是连线、高亮和状态用的标识；kind 为 human 的是人 */
  machines: {
    label: string;
    nodes: { node: string; name: string; kind: AgentKind | "human"; role: string }[];
  }[];
  /**
   * 轮播的步骤。links 里每条从 from 经房间到 to（to 为空表示只登记到房间），同一步可以有几条
   * 协作同时发生，但同一个节点不要在一步里既发又收。status 只写这一步有变化的 Agent，会累积到下一步。
   */
  steps: {
    title: string;
    detail: string;
    links: { from: string; to: string[] }[];
    status: Record<string, Status>;
  }[];
  /** 房间里的公开消息，at 是第几步出现 */
  feed: { at: number; who: string; text: string }[];
  /** 白板条目，at 是第几步出现，on 是哪几步亮起（空格分隔） */
  board: { at: number; on: string; text: string; pill: string; ok: boolean }[];
  ask: { on: number; question: string; pick: string; other: string; pickedOn: string };
}

export const teamScene: Scene = {
  id: "cm-team",
  tag: "多人协作",
  title: "每个人带着自己的 Agent，在同一个房间里协作",
  description:
    "示意图：你、林夏、周远、陈默四个人各自在自己的电脑上接着数量不同的 Agent，你的电脑上有 claude-1、claude-2 两个同种 Agent 和一个 codex。每个人、每个 Agent 都有一条线连进同一个 SuperHive 房间，房间里只有公开消息、协作白板和等人回答的问题；文件、权限和会话留在各自的电脑上。Agent 之间可以经过房间互相委派、并行干活再汇总。下面的七个步骤说明一次协作怎样在人和 Agent 之间流转。",
  room: "# web",
  layout: "rows",
  machines: [
    {
      label: "你的电脑",
      nodes: [
        { node: "you", name: "你", kind: "human", role: "定目标 · 拍板" },
        { node: "claude-1", name: "claude-1", kind: "claude", role: "统筹" },
        { node: "claude-2", name: "claude-2", kind: "claude", role: "前端" },
        { node: "codex", name: "codex", kind: "codex", role: "后端" },
      ],
    },
    {
      label: "林夏的电脑",
      nodes: [
        { node: "lin", name: "林夏", kind: "human", role: "产品" },
        { node: "lin-copilot", name: "lin-copilot", kind: "copilot", role: "文案" },
      ],
    },
    {
      label: "周远的电脑",
      nodes: [
        { node: "zhou", name: "周远", kind: "human", role: "测试" },
        { node: "zhou-omp", name: "zhou-omp", kind: "omp", role: "接口测试" },
        { node: "zhou-opencode", name: "zhou-opencode", kind: "opencode", role: "跑验证" },
      ],
    },
    {
      label: "陈默的电脑",
      nodes: [
        { node: "chen", name: "陈默", kind: "human", role: "架构" },
        { node: "chen-codex", name: "chen-codex", kind: "codex", role: "review" },
        { node: "chen-claude", name: "chen-claude", kind: "claude", role: "查文档" },
      ],
    },
  ],
  steps: [
    {
      title: "派活",
      detail: "你在房间里 @claude-1，把结算页改版交给它统筹。",
      links: [{ from: "you", to: ["claude-1"] }],
      status: { "claude-1": "run" },
    },
    {
      title: "一次委派两个",
      detail: "claude-1 拆成两份：前端给 claude-2，接口测试给周远电脑上的 zhou-omp。",
      links: [{ from: "claude-1", to: ["claude-2", "zhou-omp"] }],
      status: { "claude-1": "wait", "claude-2": "run", "zhou-omp": "run" },
    },
    {
      title: "两条协作并行",
      detail: "林夏让自己的 lin-copilot 改文案；同一时刻 zhou-omp 把测试登记到白板。",
      links: [
        { from: "lin", to: ["lin-copilot"] },
        { from: "zhou-omp", to: [] },
      ],
      status: { "lin-copilot": "run", "zhou-omp": "done" },
    },
    {
      title: "Agent 问人",
      detail: "优惠券和满减能不能叠加？claude-2 停下来，把问题交到你手里。",
      links: [{ from: "claude-2", to: ["you"] }],
      status: { "claude-2": "ask" },
    },
    {
      title: "人来回答",
      detail: "你在网页里点选「不叠加」，claude-2 接着做。",
      links: [{ from: "you", to: ["claude-2"] }],
      status: { "claude-2": "run" },
    },
    {
      title: "汇总",
      detail: "claude-2 和 zhou-omp 都把结果交回 claude-1，由它合成一份。",
      links: [
        { from: "claude-2", to: ["claude-1"] },
        { from: "zhou-omp", to: ["claude-1"] },
      ],
      status: { "claude-2": "done", "claude-1": "run", "lin-copilot": "done" },
    },
    {
      title: "交回并 review",
      detail: "claude-1 把提交交回给你，同时请陈默电脑上的 chen-codex review。",
      links: [{ from: "claude-1", to: ["you", "chen-codex"] }],
      status: { "claude-1": "done", "chen-codex": "run" },
    },
  ],
  feed: [
    { at: 0, who: "你", text: "@claude-1 结算页改版，今天上线" },
    { at: 1, who: "claude-1", text: "@claude-2 改前端 · @zhou-omp 补接口测试" },
    { at: 2, who: "林夏", text: "@lin-copilot 同步改一下结算文案" },
    { at: 3, who: "claude-2", text: "优惠券能和满减叠加吗？已提问" },
    { at: 4, who: "你", text: "选 A：不叠加" },
    { at: 5, who: "claude-1", text: "前端和测试都交回了，正在合并" },
    { at: 6, who: "claude-1", text: "已完成 b7e21f0，@chen-codex 请 review" },
  ],
  board: [
    { at: 1, on: "1", text: "结算页改版", pill: "进行中", ok: false },
    { at: 2, on: "2", text: "接口测试", pill: "已就绪", ok: true },
    { at: 5, on: "5", text: "结算文案", pill: "已就绪", ok: true },
  ],
  ask: {
    on: 3,
    question: "优惠券能和满减叠加吗？",
    pick: "A 不叠加",
    other: "B 可以叠加",
    pickedOn: "4 5 6",
  },
};

export const soloScene: Scene = {
  id: "cm-solo",
  tag: "单人 · 多 Agent 自闭环",
  title: "你一个人，用手机或电脑指挥一支 Agent 队伍",
  description:
    "示意图：只有你一个人，你可以在手机上用飞书、微信，或者在电脑网页上指挥。房间在正中间，你笔记本和工作站上的十个 Agent 环绕在四周，同一种 Agent 开了好几个（claude-1 到 claude-3、codex-1 到 codex-3），还有 omp、opencode、copilot。Agent 之间互相委派、往下再拆、并行干活、汇总和 review，你只在派活、回答问题和最后批准时出现。下面的七个步骤说明这支队伍怎样自己把一件事做完。",
  room: "# payment-split",
  layout: "orbit",
  devices: [
    { node: "feishu", name: "飞书", kind: "phone", role: "手机" },
    { node: "wechat", name: "微信", kind: "phone", role: "手机" },
    { node: "web", name: "网页", kind: "desktop", role: "电脑" },
  ],
  machines: [
    {
      label: "你的笔记本",
      nodes: [
        { node: "claude-1", name: "claude-1", kind: "claude", role: "统筹" },
        { node: "claude-2", name: "claude-2", kind: "claude", role: "接口" },
        { node: "claude-3", name: "claude-3", kind: "claude", role: "文档" },
        { node: "copilot", name: "copilot", kind: "copilot", role: "review" },
        { node: "opencode", name: "opencode", kind: "opencode", role: "跑 CI" },
      ],
    },
    {
      label: "你的工作站",
      nodes: [
        { node: "codex-1", name: "codex-1", kind: "codex", role: "数据迁移" },
        { node: "codex-2", name: "codex-2", kind: "codex", role: "测试统筹" },
        { node: "codex-3", name: "codex-3", kind: "codex", role: "前端适配" },
        { node: "omp-1", name: "omp-1", kind: "omp", role: "造数据" },
        { node: "omp-2", name: "omp-2", kind: "omp", role: "压测" },
      ],
    },
  ],
  steps: [
    {
      title: "手机上派活",
      detail: "你在手机飞书里说一句：把结算服务从单体里拆出来，交给 claude-1 统筹。",
      links: [{ from: "feishu", to: ["claude-1"] }],
      status: { "claude-1": "run" },
    },
    {
      title: "一拆四路",
      detail: "claude-1 拆成接口、文档、数据迁移、测试四路，同时派给四个 Agent。",
      links: [{ from: "claude-1", to: ["claude-2", "claude-3", "codex-1", "codex-2"] }],
      status: {
        "claude-1": "wait",
        "claude-2": "run",
        "claude-3": "run",
        "codex-1": "run",
        "codex-2": "run",
      },
    },
    {
      title: "再往下委派",
      detail: "codex-2 把测试再拆给 omp-1 造数据、omp-2 压测；claude-3 的文档已登记白板。",
      links: [
        { from: "codex-2", to: ["omp-1", "omp-2"] },
        { from: "claude-3", to: [] },
      ],
      status: { "codex-2": "wait", "omp-1": "run", "omp-2": "run", "claude-3": "done" },
    },
    {
      title: "问题推到你微信",
      detail: "迁移要不要停机？codex-1 把问题推到你微信上，其他几路照常干活。",
      links: [{ from: "codex-1", to: ["wechat"] }],
      status: { "codex-1": "ask" },
    },
    {
      title: "微信里回答，测试交回",
      detail: "你在微信里回「凌晨停机」；同一时刻 omp-1、omp-2 把结果交回 codex-2。",
      links: [
        { from: "wechat", to: ["codex-1"] },
        { from: "omp-1", to: ["codex-2"] },
        { from: "omp-2", to: ["codex-2"] },
      ],
      status: { "codex-1": "run", "omp-1": "done", "omp-2": "done", "codex-2": "run" },
    },
    {
      title: "三路汇总",
      detail: "claude-2、codex-1、codex-2 都交回 claude-1，由它合成一个提交。",
      links: [
        { from: "claude-2", to: ["claude-1"] },
        { from: "codex-1", to: ["claude-1"] },
        { from: "codex-2", to: ["claude-1"] },
      ],
      status: { "claude-2": "done", "codex-1": "done", "codex-2": "done", "claude-1": "run" },
    },
    {
      title: "review，电脑上批准",
      detail: "claude-1 请 copilot review、opencode 跑 CI，结果送到你电脑上，你批准合入。",
      links: [{ from: "claude-1", to: ["copilot", "opencode", "web"] }],
      status: { "claude-1": "done", copilot: "run", opencode: "run" },
    },
  ],
  feed: [
    { at: 0, who: "你 · 飞书", text: "@claude-1 把结算服务从单体里拆出来" },
    {
      at: 1,
      who: "claude-1",
      text: "@claude-2 接口 · @claude-3 文档 · @codex-1 迁移 · @codex-2 测试",
    },
    { at: 2, who: "codex-2", text: "@omp-1 造测试数据 · @omp-2 压测" },
    { at: 3, who: "codex-1", text: "迁移要停机 5 分钟吗？已推到你微信" },
    { at: 4, who: "你 · 微信", text: "选 A：凌晨停机" },
    { at: 5, who: "claude-1", text: "三路都交回了，正在合并" },
    { at: 6, who: "claude-1", text: "c3f9a10 已就绪，@copilot review · @opencode 跑 CI" },
  ],
  board: [
    { at: 1, on: "1", text: "结算服务拆分", pill: "进行中", ok: false },
    { at: 2, on: "2", text: "接口文档", pill: "已就绪", ok: true },
    { at: 4, on: "4", text: "测试与压测", pill: "已就绪", ok: true },
  ],
  ask: {
    on: 3,
    question: "迁移要停机 5 分钟吗？",
    pick: "A 凌晨停机",
    other: "B 不停机灰度",
    pickedOn: "4 5 6",
  },
};

// 英文页用的同一套演示：节点、连线和步骤结构与中文完全一致，只换文字。
export const teamSceneEn: Scene = {
  ...teamScene,
  tag: "Team",
  title: "Everyone brings their own agents into the same room",
  description:
    "Diagram: four people — you, Lin, Zhou and Chen — each run a different number of agents on their own computers. Your computer has two agents of the same kind, claude-1 and claude-2, plus a codex. Every person and every agent has its own line into the same SuperHive room, which holds only public messages, the whiteboard and questions waiting for a person; files, permissions and sessions stay on each computer. Agents delegate to each other through the room, work in parallel and merge results. The seven steps below show how one piece of work moves between people and agents.",
  machines: [
    {
      label: "Your computer",
      nodes: [
        { node: "you", name: "You", kind: "human", role: "Goals · decisions" },
        { node: "claude-1", name: "claude-1", kind: "claude", role: "Lead" },
        { node: "claude-2", name: "claude-2", kind: "claude", role: "Frontend" },
        { node: "codex", name: "codex", kind: "codex", role: "Backend" },
      ],
    },
    {
      label: "Lin's computer",
      nodes: [
        { node: "lin", name: "Lin", kind: "human", role: "Product" },
        { node: "lin-copilot", name: "lin-copilot", kind: "copilot", role: "Copy" },
      ],
    },
    {
      label: "Zhou's computer",
      nodes: [
        { node: "zhou", name: "Zhou", kind: "human", role: "QA" },
        { node: "zhou-omp", name: "zhou-omp", kind: "omp", role: "API tests" },
        { node: "zhou-opencode", name: "zhou-opencode", kind: "opencode", role: "Checks" },
      ],
    },
    {
      label: "Chen's computer",
      nodes: [
        { node: "chen", name: "Chen", kind: "human", role: "Architecture" },
        { node: "chen-codex", name: "chen-codex", kind: "codex", role: "Review" },
        { node: "chen-claude", name: "chen-claude", kind: "claude", role: "Research" },
      ],
    },
  ],
  steps: [
    {
      title: "Assign work",
      detail: "You @claude-1 in the room and hand it the checkout page redesign to lead.",
      links: [{ from: "you", to: ["claude-1"] }],
      status: { "claude-1": "run" },
    },
    {
      title: "Delegate to two at once",
      detail:
        "claude-1 splits the work: frontend to claude-2, API tests to zhou-omp on Zhou's computer.",
      links: [{ from: "claude-1", to: ["claude-2", "zhou-omp"] }],
      status: { "claude-1": "wait", "claude-2": "run", "zhou-omp": "run" },
    },
    {
      title: "Two threads in parallel",
      detail:
        "Lin asks her lin-copilot to rewrite the copy; meanwhile zhou-omp posts the tests to the whiteboard.",
      links: [
        { from: "lin", to: ["lin-copilot"] },
        { from: "zhou-omp", to: [] },
      ],
      status: { "lin-copilot": "run", "zhou-omp": "done" },
    },
    {
      title: "An agent asks a person",
      detail:
        "Can coupons stack with bundle discounts? claude-2 pauses and puts the question in your hands.",
      links: [{ from: "claude-2", to: ["you"] }],
      status: { "claude-2": "ask" },
    },
    {
      title: "A person answers",
      detail: "You pick “Don't stack” on the web page, and claude-2 carries on.",
      links: [{ from: "you", to: ["claude-2"] }],
      status: { "claude-2": "run" },
    },
    {
      title: "Merge results",
      detail:
        "claude-2 and zhou-omp both hand their results back to claude-1, which combines them.",
      links: [
        { from: "claude-2", to: ["claude-1"] },
        { from: "zhou-omp", to: ["claude-1"] },
      ],
      status: { "claude-2": "done", "claude-1": "run", "lin-copilot": "done" },
    },
    {
      title: "Hand back and review",
      detail:
        "claude-1 hands the commit back to you and asks chen-codex on Chen's computer to review it.",
      links: [{ from: "claude-1", to: ["you", "chen-codex"] }],
      status: { "claude-1": "done", "chen-codex": "run" },
    },
  ],
  feed: [
    { at: 0, who: "You", text: "@claude-1 redesign the checkout page, ship today" },
    { at: 1, who: "claude-1", text: "@claude-2 frontend · @zhou-omp add API tests" },
    { at: 2, who: "Lin", text: "@lin-copilot update the checkout copy too" },
    { at: 3, who: "claude-2", text: "Can coupons stack with discounts? Asked" },
    { at: 4, who: "You", text: "Picked A: don't stack" },
    { at: 5, who: "claude-1", text: "Frontend and tests are back, merging" },
    { at: 6, who: "claude-1", text: "Done in b7e21f0, @chen-codex please review" },
  ],
  board: [
    { at: 1, on: "1", text: "Checkout redesign", pill: "Running", ok: false },
    { at: 2, on: "2", text: "API tests", pill: "Ready", ok: true },
    { at: 5, on: "5", text: "Checkout copy", pill: "Ready", ok: true },
  ],
  ask: {
    on: 3,
    question: "Can coupons stack with discounts?",
    pick: "A Don't stack",
    other: "B Allow stacking",
    pickedOn: "4 5 6",
  },
};

export const soloSceneEn: Scene = {
  ...soloScene,
  tag: "Solo · self-driving agent team",
  title: "Just you, running a team of agents from your phone or desktop",
  description:
    "Diagram: there is only you, giving directions from Feishu or WeChat on your phone, or from the web app on your desktop. The room sits in the middle, surrounded by ten agents on your laptop and workstation, including several of the same kind (claude-1 to claude-3, codex-1 to codex-3) plus omp, opencode and copilot. The agents delegate to each other, split work further, run in parallel, merge and review; you only step in to assign work, answer questions and give the final approval. The seven steps below show how the team finishes a job on its own.",
  devices: [
    { node: "feishu", name: "Feishu", kind: "phone", role: "Phone" },
    { node: "wechat", name: "WeChat", kind: "phone", role: "Phone" },
    { node: "web", name: "Web", kind: "desktop", role: "Desktop" },
  ],
  machines: [
    {
      label: "Your laptop",
      nodes: [
        { node: "claude-1", name: "claude-1", kind: "claude", role: "Lead" },
        { node: "claude-2", name: "claude-2", kind: "claude", role: "API" },
        { node: "claude-3", name: "claude-3", kind: "claude", role: "Docs" },
        { node: "copilot", name: "copilot", kind: "copilot", role: "Review" },
        { node: "opencode", name: "opencode", kind: "opencode", role: "CI" },
      ],
    },
    {
      label: "Your workstation",
      nodes: [
        { node: "codex-1", name: "codex-1", kind: "codex", role: "Migration" },
        { node: "codex-2", name: "codex-2", kind: "codex", role: "Test lead" },
        { node: "codex-3", name: "codex-3", kind: "codex", role: "Frontend" },
        { node: "omp-1", name: "omp-1", kind: "omp", role: "Test data" },
        { node: "omp-2", name: "omp-2", kind: "omp", role: "Load test" },
      ],
    },
  ],
  steps: [
    {
      title: "Assign from your phone",
      detail:
        "In Feishu on your phone you say: split the checkout service out of the monolith, claude-1 leads.",
      links: [{ from: "feishu", to: ["claude-1"] }],
      status: { "claude-1": "run" },
    },
    {
      title: "Split four ways",
      detail:
        "claude-1 splits the job into API, docs, data migration and tests, and hands them to four agents at once.",
      links: [{ from: "claude-1", to: ["claude-2", "claude-3", "codex-1", "codex-2"] }],
      status: {
        "claude-1": "wait",
        "claude-2": "run",
        "claude-3": "run",
        "codex-1": "run",
        "codex-2": "run",
      },
    },
    {
      title: "Delegate further down",
      detail:
        "codex-2 passes test data to omp-1 and load testing to omp-2; claude-3 posts the docs to the whiteboard.",
      links: [
        { from: "codex-2", to: ["omp-1", "omp-2"] },
        { from: "claude-3", to: [] },
      ],
      status: { "codex-2": "wait", "omp-1": "run", "omp-2": "run", "claude-3": "done" },
    },
    {
      title: "A question reaches WeChat",
      detail:
        "Does the migration need downtime? codex-1 sends the question to your WeChat while the others keep working.",
      links: [{ from: "codex-1", to: ["wechat"] }],
      status: { "codex-1": "ask" },
    },
    {
      title: "Answer in WeChat, tests return",
      detail:
        "You reply “Downtime overnight” in WeChat; at the same time omp-1 and omp-2 hand results back to codex-2.",
      links: [
        { from: "wechat", to: ["codex-1"] },
        { from: "omp-1", to: ["codex-2"] },
        { from: "omp-2", to: ["codex-2"] },
      ],
      status: { "codex-1": "run", "omp-1": "done", "omp-2": "done", "codex-2": "run" },
    },
    {
      title: "Three threads merge",
      detail:
        "claude-2, codex-1 and codex-2 all hand back to claude-1, which combines them into one commit.",
      links: [
        { from: "claude-2", to: ["claude-1"] },
        { from: "codex-1", to: ["claude-1"] },
        { from: "codex-2", to: ["claude-1"] },
      ],
      status: { "claude-2": "done", "codex-1": "done", "codex-2": "done", "claude-1": "run" },
    },
    {
      title: "Review, approve on desktop",
      detail:
        "claude-1 asks copilot to review and opencode to run CI; the results reach your desktop and you approve the merge.",
      links: [{ from: "claude-1", to: ["copilot", "opencode", "web"] }],
      status: { "claude-1": "done", copilot: "run", opencode: "run" },
    },
  ],
  feed: [
    { at: 0, who: "You · Feishu", text: "@claude-1 split checkout out of the monolith" },
    {
      at: 1,
      who: "claude-1",
      text: "@claude-2 API · @claude-3 docs · @codex-1 migration · @codex-2 tests",
    },
    { at: 2, who: "codex-2", text: "@omp-1 test data · @omp-2 load test" },
    { at: 3, who: "codex-1", text: "5 min downtime for the migration? Sent to your WeChat" },
    { at: 4, who: "You · WeChat", text: "Picked A: downtime overnight" },
    { at: 5, who: "claude-1", text: "All three threads are back, merging" },
    { at: 6, who: "claude-1", text: "c3f9a10 ready, @copilot review · @opencode run CI" },
  ],
  board: [
    { at: 1, on: "1", text: "Split checkout service", pill: "Running", ok: false },
    { at: 2, on: "2", text: "API docs", pill: "Ready", ok: true },
    { at: 4, on: "4", text: "Tests and load test", pill: "Ready", ok: true },
  ],
  ask: {
    on: 3,
    question: "5 min downtime for the migration?",
    pick: "A Downtime overnight",
    other: "B Canary, no downtime",
    pickedOn: "4 5 6",
  },
};

export const collabScenes = {
  "zh-CN": { solo: soloScene, team: teamScene },
  en: { solo: soloSceneEn, team: teamSceneEn },
} as const;

/** 协作图上固定的界面文字 */
export const collabText = {
  "zh-CN": {
    badge: "示意图",
    pause: "暂停",
    play: "播放",
    youIcon: "你",
    youTitle: "你一个人",
    youDetail: "手机、电脑都能指挥",
    localShort: "留在本机",
    localLong: "文件 · 权限 · 会话留在本机",
    roomKind: "同一个 SuperHive 房间",
    roomNote: "只走公开消息",
    feed: "公开消息",
    board: "协作白板",
    ask: "等你回答",
    caption: "示意图，人名、Agent 名和任务均为演示数据。",
    more: "了解委派、进展与提问",
    status: { run: "执行中", wait: "等结果", ask: "等你回答", done: "已交回" },
  },
  en: {
    badge: "Diagram",
    pause: "Pause",
    play: "Play",
    youIcon: "Y",
    youTitle: "Just you",
    youDetail: "Phone or desktop",
    localShort: "Stays local",
    localLong: "Files · permissions · sessions stay local",
    roomKind: "One shared SuperHive room",
    roomNote: "Public messages only",
    feed: "Public messages",
    board: "Whiteboard",
    ask: "Waiting for your answer",
    caption: "Diagram. People, agent names and tasks are demo data.",
    more: "Learn about delegation, progress and questions",
    status: { run: "Running", wait: "Waiting", ask: "Needs you", done: "Handed back" },
  },
} as const;

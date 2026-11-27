/* global window, location, URL, URLSearchParams, Response, MessageEvent */
// 截图用的测试替身：沙箱里 /api/local/* 是关的，Server 也不推故障单和慢操作。
// 和 local-agents.js 一起用（它负责假装页面开在 Server 所在电脑上）：
//   pnpm screenshot --url $SANDBOX_URL --init-script scripts/fixtures/local-agents.js \
//     --init-script scripts/fixtures/incidents.js --action "click:[aria-label^='故障']"
// 给出几张故障单（升级给人、待处理、修复中、已解决、外部原因）、一条待批准的规则提议和几条慢操作。
// 地址里加 ?slowOps=60 再多造 60 条慢操作，看列表很长时弹窗怎么滚。
(() => {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  let sequence = 0;
  const incident = (patch) => {
    sequence++;
    return {
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      fingerprint: `server:TypeError:f${sequence}`,
      origin: "internal",
      source: "server",
      title: "TypeError: Cannot read properties of undefined",
      status: "open",
      count: 3,
      recentCount: 3,
      firstSeenAt: ago(600),
      lastSeenAt: ago(sequence * 7),
      samples: [
        {
          at: ago(sequence * 7),
          route: "GET /api/rooms/:id/worktrees",
          roomId: "build",
          codeVersion: "1af233a0d1e2f3a4b5c6",
          stack:
            "TypeError: Cannot read properties of undefined (reading 'branch')\n    at listWorktrees (apps/server/src/worktrees.ts)\n    at handler (apps/server/src/app.ts)",
        },
      ],
      failedAttempts: 0,
      dispatches: [],
      reopenedCount: 0,
      updatedAt: ago(sequence * 7),
      ...patch,
    };
  };
  const incidents = [
    incident({
      status: "escalated",
      title: "invocation.stale：Bridge 报告完成但 Server 仍在等待（claude）",
      source: "invocation",
      count: 7,
      failedAttempts: 2,
      noteText: { key: "incident.note.escalatedAttempts", params: { count: 2 } },
      dispatches: [
        {
          id: "d1",
          attempt: 1,
          agentName: "rd-claude2",
          at: ago(300),
          outcome: "failed",
          reason: "调用超时",
        },
        {
          id: "d2",
          attempt: 2,
          agentName: "rd-claude2",
          at: ago(120),
          outcome: "failed",
          reason: "修好后又出现",
        },
      ],
    }),
    incident({}),
    incident({
      status: "fixing",
      source: "web",
      title: "TypeError: Cannot read properties of null (reading 'scrollTop')",
      count: 4,
      dispatches: [
        { id: "d3", attempt: 1, agentName: "rd-claude4", at: ago(20), outcome: "pending" },
      ],
    }),
    incident({ status: "resolved", title: "RangeError: Invalid time value", count: 5 }),
    incident({
      origin: "external",
      source: "invocation",
      title: "上游模型服务出错（codex）",
      count: 12,
    }),
  ];
  const proposals = [
    {
      id: "p1",
      roomId: "build",
      agentName: "rd-claude2",
      text: "改动 Server 的 WebSocket 事件前，先跑 protocol 和 web 的全量测试",
      reason: "上次只跑了 server 测试，网页收到新事件后报协议校验失败",
      status: "pending",
      createdAt: ago(45),
    },
  ];
  const data = {
    incidents,
    lessons: [],
    proposals,
    settings: {
      autoDispatch: false,
      roomId: "build",
      requester: "rd",
      fixer: "rd-claude2",
      reviewer: "rd-claude",
      threshold: 3,
      dailyLimit: 3,
      maxAttempts: 2,
    },
    dispatchedToday: 0,
    protectedPaths: ["apps/server/src/agent-instructions.ts", "apps/server/src/incidents.ts"],
    runningCommit: "1af233a0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
  };
  const slow = (minutes, patch) => ({
    id: `slow-${minutes}`,
    at: ago(minutes),
    kind: "git",
    name: "git status",
    durationMs: 4_200,
    ...patch,
  });
  const slowOps = {
    type: "slow-op.snapshot",
    thresholdMs: 3000,
    requestThresholdMs: 5000,
    capacity: 200,
    alertMs: 15_000,
    lockWaitAlertMs: 10_000,
    operations: [
      slow(2, {
        kind: "lock",
        name: "worktrees.lock runtimeWorkspaces",
        durationMs: 120,
        waitMs: 25_400,
        source: "POST /api/agent/worktree",
        repo: "/Users/rd/Coding/ai-hive",
      }),
      slow(3, { repo: "/Users/rd/Coding/ai-hive" }),
      slow(9, { name: "git fetch", durationMs: 8_300, failed: true }),
      slow(15, { kind: "request", name: "GET /api/rooms/build/messages", durationMs: 6_100 }),
    ],
  };
  const extraSlowOps = Number(new URLSearchParams(location.search).get("slowOps")) || 0;
  const kinds = [
    { kind: "operation", name: "worktrees.list", source: "GET /api/local/worktrees/:roomId" },
    { kind: "git", name: "git cherry", source: "worktrees.merged" },
    { kind: "request", name: "GET /api/local/worktrees/:roomId", status: 200 },
    { kind: "operation", name: "worktrees.status", failed: true, source: "worktrees.list" },
  ];
  for (let index = 0; index < extraSlowOps; index++) {
    slowOps.operations.push(
      slow(20 + index, {
        ...kinds[index % kinds.length],
        id: `slow-extra-${index}`,
        durationMs: 3_100 + ((index * 977) % 11_000),
        roomId: "build",
      }),
    );
  }
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    addEventListener(type, listener, options) {
      if (type !== "message") return super.addEventListener(type, listener, options);
      return super.addEventListener(
        type,
        (event) => {
          const type = JSON.parse(event.data).type;
          // 沙箱 Server 自己推的（空的）慢操作全集和故障单数字换成下面的假数据
          if (type === "slow-op.snapshot" || type === "incidents.changed") return;
          listener.call(this, event);
          if (type !== "room.snapshot") return;
          // 真实 Server 连上时给本机房主页面推的两条
          for (const extra of [slowOps, { type: "incidents.changed", attention: 2 }]) {
            listener.call(this, new MessageEvent("message", { data: JSON.stringify(extra) }));
          }
        },
        options,
      );
    }
  };
  const json = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  // 派修设置里按房间列 Agent：沙箱里的 Agent 都不在线，换成几个在线、忙、离线的
  const agent = (username, provider, status) => ({
    id: `00000000-0000-4000-9000-${username.length.toString().padStart(12, "0")}`,
    roomId: "build",
    username,
    type: "agent",
    status,
    provider,
    joinedAt: ago(6000),
    lastSeenAt: ago(1),
  });
  const participants = [
    agent("rd-claude", "claude", "online"),
    agent("rd-claude2", "claude", "busy"),
    agent("rd-codex", "codex", "online"),
    agent("glm", "omp", "offline"),
    agent("rd-opencode", "opencode", "offline"),
  ];
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    if (url === "/api/local/incidents") return json(data);
    if (url === "/api/local/incidents/settings") {
      Object.assign(data.settings, JSON.parse(init.body ?? "{}"));
      return json(data.settings);
    }
    if (url === "/api/rooms/build/participants") return json({ participants });
    return original(input, init);
  };
})();

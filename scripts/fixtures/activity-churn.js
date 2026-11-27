/* global window, location, URL, URLSearchParams, Response, MessageEvent */
// 截图用的测试替身：「Agent 任务」弹窗里的调用持续变化，看往下翻到用量时位置会不会跳。
// 沙箱里没有 Agent 在跑，这里假装有十几个调用：每隔一会儿推一条 invocation.updated（进度变了、
// 跑完带回用量、新的调用开始），/api/invocations 也返回同一份数据。用量统计走沙箱里的真实数据。
//   pnpm preview:sandbox --from-data <数据目录> -- node scripts/screenshot.mjs --url {url} --room build \
//     --init-script scripts/fixtures/activity-churn.js --action "click:.sidebar-action[aria-label^='Agent']"
// 默认每秒推一条；地址里加 ?churn=毫秒 改间隔，?churn=0 不自动推，手动调 window.__churn.tick()。
(() => {
  const params = new URLSearchParams(location.search);
  const interval = Number(params.get("churn") ?? 1000);
  const agents = ["rd-claude", "rd-claude2", "rd-claude3", "rd-claude4", "rd-codex", "glm"];
  const steps = ["读代码", "跑测试", "改样式", "写单测", "截图", "整理交付", "等构建"];
  let sequence = 0;
  let roomId = "build";
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const iso = (offset = 0) => new Date(Date.now() - offset).toISOString();
  const messages = new Map();
  const invocations = new Map();

  const start = () => {
    sequence++;
    const agentName = agents[sequence % agents.length];
    const message = {
      id: uuid(10_000 + sequence),
      roomId,
      seq: 900_000 + sequence,
      senderId: uuid(1),
      senderName: "rd",
      senderType: "human",
      content: `@${agentName} 第 ${sequence} 件事：把这一块改好，补单测、截图后交回 review`,
      mentions: [agentName],
      createdAt: iso(sequence * 1000),
    };
    messages.set(message.id, message);
    const invocation = {
      id: uuid(20_000 + sequence),
      roomId,
      messageId: message.id,
      agentId: uuid(30_000 + (sequence % agents.length)),
      agentName,
      requesterName: "rd",
      requesterType: "human",
      status: "running",
      progress: steps[sequence % steps.length],
      attempts: 1,
      createdAt: iso(sequence * 1000),
      updatedAt: iso(),
      startedAt: iso(sequence * 1000),
    };
    invocations.set(invocation.id, invocation);
    return invocation;
  };
  for (let i = 0; i < 12; i++) start();

  const listeners = new Set();
  const emit = (invocation) => {
    const data = JSON.stringify({ type: "invocation.updated", invocation });
    for (const listener of listeners) listener(new MessageEvent("message", { data }));
  };

  let tick = 0;
  const next = () => {
    tick++;
    const running = [...invocations.values()].filter((item) => item.status === "running");
    const target = running[tick % running.length];
    if (!target) return emit(start());
    if (tick % 5 === 0) {
      // 跑完：带回用量后离开列表，同时开始一件新的
      const done = {
        ...target,
        status: "completed",
        updatedAt: iso(),
        finishedAt: iso(),
        usage: {
          inputTokens: 1200,
          cacheWriteTokens: 0,
          cacheReadTokens: 40_000,
          outputTokens: 800,
          turns: 1,
          requests: 3,
        },
      };
      invocations.delete(target.id);
      emit(done);
      emit(start());
      return;
    }
    const updated = {
      ...target,
      progress: `${steps[tick % steps.length]} · 第 ${tick} 步`,
      updatedAt: iso(),
    };
    invocations.set(updated.id, updated);
    emit(updated);
  };
  window.__churn = {
    tick: next,
    get count() {
      return tick;
    },
  };
  if (interval > 0) window.setInterval(next, interval);

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    addEventListener(type, listener, options) {
      if (type !== "message") return super.addEventListener(type, listener, options);
      const wrapped = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "room.snapshot" && data.self?.roomId) roomId = data.self.roomId;
        listener.call(this, event);
      };
      listeners.add((event) => listener.call(this, event));
      return super.addEventListener(type, wrapped, options);
    }
  };

  const json = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    if (url === "/api/invocations") {
      return json({
        invocations: [...invocations.values()].map((item) => ({ ...item, roomId })),
        messages: [...messages.values()].map((item) => ({ ...item, roomId })),
        onlineInvocationIds: [...invocations.keys()],
      });
    }
    return original(input, init);
  };
})();

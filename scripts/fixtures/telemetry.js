/* global window, location, URL, URLSearchParams, Response */
// 截图用的测试替身：沙箱里统计一律关着（HIVE_SANDBOX=1），这里假装统计开着、有几条待发的数据。
// 和 local-agents.js 一起用（它负责假装页面开在 Server 所在电脑上）：
//   pnpm screenshot --url "$SANDBOX_URL/?telemetry=on" --init-script scripts/fixtures/local-agents.js \
//     --init-script scripts/fixtures/telemetry.js --action settings:computer
// ?telemetry=on 开着、首次告知还没弹；?telemetry=seen 开着、已经告知过；?telemetry=blocked 被 DO_NOT_TRACK 挡住
(() => {
  const mode = new URLSearchParams(location.search).get("telemetry") ?? "on";
  const context = {
    version: "0.4.9",
    runMode: "npm",
    os: "darwin",
    arch: "arm64",
    locale: "zh-CN",
  };
  const time = "2026-11-28T04:00:00.000Z";
  const events = [
    {
      event: "heartbeat",
      time,
      context,
      props: { agents: { claude: 4, codex: 1, omp: 1 }, rooms: "2-5" },
    },
    { event: "incident_counts", time, context, props: { counts: { "external.invocation": 2 } } },
    { event: "feature_first_used", time, context, props: { feature: "room_create" } },
    { event: "feature_first_used", time, context, props: { feature: "code_panel" } },
    {
      event: "update_result",
      time,
      context,
      props: {
        kind: "agent_cli",
        outcome: "failure",
        reason: "timeout",
        target: "claude",
        action: "upgrade",
      },
    },
    { event: "update_result", time, context, props: { kind: "npm", outcome: "success" } },
  ];
  // 和 telemetry-core.ts 的 umamiEvent 同样的格式：预览里看到的是发给 Umami 的请求体
  const umami = (item) => {
    const data = { schema: 1, ...item.context };
    for (const [name, value] of Object.entries(item.props)) {
      if (typeof value === "string") data[name] = value;
      else
        for (const [key, count] of Object.entries(value))
          data[`${name}_${key.replaceAll(".", "_")}`] = count;
    }
    return {
      type: "event",
      payload: {
        website: "b2d13ec6-3fa6-47bf-9cbd-7317357517fc",
        hostname: "superhive.app",
        url: `/${item.event}`,
        name: item.event,
        language: item.context.locale,
        timestamp: Date.parse(item.time) / 1000,
        id: installId,
        data,
      },
    };
  };
  let installId = "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f";
  let enabled = true;
  let queued = events.length;
  let noticePending = mode === "on";
  const blocker = mode === "blocked" ? "do_not_track" : undefined;
  const status = () => ({
    active: enabled && !blocker,
    enabled,
    ...(blocker ? { blocker } : {}),
    installId,
    endpoint: false,
    queued: enabled && !blocker ? queued : 0,
    noticePending: noticePending && enabled && !blocker,
  });
  const json = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (url === "/api/local/telemetry" && method === "GET") return json(status());
    if (url === "/api/local/telemetry" && method === "PUT") {
      enabled = Boolean(JSON.parse(String(init.body ?? "{}")).enabled);
      noticePending = false;
      if (!enabled) queued = 0;
      return json(status());
    }
    if (url === "/api/local/telemetry/notice") {
      noticePending = false;
      return json(status());
    }
    if (url === "/api/local/telemetry/reset") {
      installId = "3b7a9e52-61c4-4f0d-9a8b-2c1d0e3f4a5b";
      queued = 0;
      return json(status());
    }
    if (url === "/api/local/telemetry/preview") {
      const active = enabled && !blocker;
      return json({ payload: active ? events.slice(0, queued).map(umami) : null });
    }
    return original(input, init);
  };
})();

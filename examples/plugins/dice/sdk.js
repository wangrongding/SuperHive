/* global window */
// 插件这边的最小 SDK：只有 postMessage，没有别的通道
(() => {
  let next = 1;
  const pending = new Map();
  const listeners = new Map();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.superhive !== 1) return;
    if (data.kind === "result" || data.kind === "error") {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.kind === "result") entry.resolve(data.result);
      else entry.reject(Object.assign(new Error(data.message), { code: data.code }));
    } else if (data.kind === "event") {
      for (const fn of listeners.get(data.event) ?? []) fn(data.data);
    }
  });
  window.superhive = {
    call(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // 宿主源未知（面板是不透明源），只能发 "*"；宿主按 event.source 认面板
        window.parent.postMessage({ superhive: 1, kind: "request", id, method, params }, "*");
      });
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
  };
})();

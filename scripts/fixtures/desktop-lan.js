/* global window, location, URLSearchParams */
// 截图用的测试替身：假装页面开在桌面客户端里，给出「允许局域网设备访问」开关。
// 和 local-agents.js 一起用（它负责假装页面开在 Server 所在电脑上、给出已登录设备）：
//   pnpm screenshot --url "$SANDBOX_URL/?lan=blocked" --init-script scripts/fixtures/local-agents.js \
//     --init-script scripts/fixtures/desktop-lan.js --action settings:devices
// ?lan=off 开关关着；?lan=blocked 开着且 Windows 防火墙拦着；?lan=missing 开着、还没放行；?lan=on 开着、已放行
(() => {
  const mode = new URLSearchParams(location.search).get("lan") ?? "off";
  const noop = () => () => undefined;
  let state = { enabled: mode !== "off", managed: true, restarting: false };
  const listeners = new Set();
  const program = "C:\\Users\\rd\\AppData\\Local\\SuperHive\\app-0.5.0\\SuperHive.exe";
  window.superhiveDesktop = Object.freeze({
    version: 1,
    platform: "win32",
    terminal: {
      create: async () => ({ id: "t", shell: "pwsh", cwd: "C:\\" }),
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: noop,
      onExit: noop,
      onNewRequest: noop,
    },
    lan: {
      get: async () => state,
      set: async (enabled) => {
        state = { ...state, enabled };
        for (const listener of listeners) listener(state);
        return state;
      },
      firewall: async () =>
        state.enabled ? { status: mode === "on" || mode === "off" ? "ok" : mode, program } : null,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
})();

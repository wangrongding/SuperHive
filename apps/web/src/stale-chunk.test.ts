// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientErrorReport } from "@superhive/protocol";
import { DEV_RELOAD_GRACE_MS, installErrorReporter, isDevNoise } from "./error-report";
import {
  STALE_CHUNK_RELOAD_KEY,
  STALE_CHUNK_RELOAD_WINDOW_MS,
  installStaleChunkRecovery,
  isStaleChunkError,
  reloadForStaleChunk,
  resetStaleChunkRecovery,
} from "./stale-chunk";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const STALE =
  "Failed to fetch dynamically imported module: http://127.0.0.1:8787/assets/terminal-panel-DWiPULEk.js";

describe("stale chunk recovery", () => {
  beforeEach(() => resetStaleChunkRecovery());

  it("recognizes each browser's wording", () => {
    expect(isStaleChunkError(STALE)).toBe(true);
    expect(isStaleChunkError("error loading dynamically imported module: /assets/x.js")).toBe(true);
    expect(isStaleChunkError("Importing a module script failed.")).toBe(true);
    expect(isStaleChunkError("x is undefined")).toBe(false);
  });

  it("reloads once, then lets the error through if it fails again soon after", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForStaleChunk({ storage, reload, now: 1_000 })).toBe(true);
    // 同一页面再遇到：已经在刷新了，不重复刷新
    expect(reloadForStaleChunk({ storage, reload, now: 1_001 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe("1000");

    // 刷新后的新页面：几分钟内又失败，不再刷新，交给上报
    resetStaleChunkRecovery();
    expect(reloadForStaleChunk({ storage, reload, now: 61_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // 过了这段时间（又一次发版）可以再自动刷新
    expect(
      reloadForStaleChunk({ storage, reload, now: 1_000 + STALE_CHUNK_RELOAD_WINDOW_MS }),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when it cannot remember having reloaded", () => {
    const reload = vi.fn();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(reloadForStaleChunk({ storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("swallows Vite's preload error while reloading, and reloads on uncaught chunk errors", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const uninstall = installStaleChunkRecovery({ storage, reload });
    const preload = new Event("vite:preloadError", { cancelable: true }) as Event & {
      payload?: unknown;
    };
    preload.payload = new TypeError(STALE);
    window.dispatchEvent(preload);
    expect(preload.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();

    resetStaleChunkRecovery();
    const fresh = memoryStorage();
    const again = installStaleChunkRecovery({ storage: fresh, reload });
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new TypeError(STALE);
    window.dispatchEvent(rejection);
    expect(reload).toHaveBeenCalledTimes(2);
    again();
  });
});

describe("error reporter noise", () => {
  const sent: string[] = [];
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    sent.length = 0;
  });
  const install = (options: { dev?: boolean; reload?: () => boolean } = {}) => {
    uninstall = installErrorReporter({
      base: "",
      token: "t",
      roomId: () => undefined,
      send: (report: ClientErrorReport) => sent.push(report.message),
      ...(options.dev !== undefined ? { dev: options.dev } : {}),
      ...(options.reload ? { reloadForStaleChunk: options.reload } : {}),
    });
  };
  const fire = (message: string, stack: string) => {
    const error = new TypeError(message);
    error.stack = stack;
    window.dispatchEvent(new ErrorEvent("error", { error, message }));
  };
  const hmrStack =
    "ReferenceError: Button is not defined\n    at Composer (http://localhost:5188/src/composer.tsx?t=1795578227463:661:43)";
  const mixedDeps =
    "TypeError: Cannot read properties of null (reading 'useRef')\n    at exports.useRef (http://localhost:5188/node_modules/.vite/deps/react-BBoXEtLn.js?v=3619afb2:766:30)\n    at renderWithHooks (http://localhost:5188/node_modules/.vite/deps/react-dom_client.js?v=7c706b7b:4398:19)";

  it("keeps hot-update and re-bundled dependency errors out of incidents in dev", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    install({ dev: true });
    fire("Button is not defined", hmrStack);
    fire("Cannot read properties of null (reading 'useRef')", mixedDeps);
    expect(sent).toEqual([]);
    vi.restoreAllMocks();
  });

  it("still reports the same stacks from a production build", () => {
    install({ dev: false });
    fire("Button is not defined", hmrStack);
    expect(sent).toEqual(["Button is not defined"]);
  });

  it("treats errors shortly after a hot update as dev noise", () => {
    const stack = "TypeError: boom\n    at Panel (http://localhost:5188/src/panel.tsx:3:10)";
    expect(isDevNoise({ stack }, 10_000, 0)).toBe(true);
    expect(isDevNoise({ stack }, DEV_RELOAD_GRACE_MS + 1, 0)).toBe(false);
  });

  it("reloads instead of reporting a stale chunk, and reports it if the reload did not help", () => {
    let reloaded = false;
    install({ reload: () => (reloaded ? false : (reloaded = true)) });
    fire(STALE, `TypeError: ${STALE}`);
    expect(sent).toEqual([]);
    // 刷新后的页面里又失败（同一个报错一分钟内去重，换个文件名）
    fire(`${STALE}x`, `TypeError: ${STALE}x`);
    expect(sent).toEqual([`${STALE}x`]);
  });
});

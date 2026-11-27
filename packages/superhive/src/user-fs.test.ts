import * as nodeFs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { pickUserFs, userFs, userFsPromises } from "./user-fs.js";

const versions = (electron?: string) =>
  ({ ...process.versions, ...(electron ? { electron } : {}) }) as NodeJS.ProcessVersions;

describe("pickUserFs", () => {
  it("Electron 下走 original-fs（不带 asar 补丁的那份）", () => {
    const originalFs = { promises: {} } as unknown as typeof nodeFs;
    const load = vi.fn(() => originalFs);
    expect(pickUserFs(versions("45.4.1"), load)).toBe(originalFs);
    expect(load).toHaveBeenCalledWith("original-fs");
  });

  it("不是 Electron 就是 node:fs，也不去加载 original-fs", () => {
    const load = vi.fn();
    const fs = pickUserFs(versions(), load);
    expect(fs.statSync).toBe(nodeFs.statSync);
    expect(fs.promises).toBe(nodeFs.promises);
    expect(load).not.toHaveBeenCalled();
  });

  it("Electron 里拿不到 original-fs 时退回 node:fs", () => {
    const fs = pickUserFs(versions("45.4.1"), () => {
      throw new Error("Cannot find module 'original-fs'");
    });
    expect(fs.statSync).toBe(nodeFs.statSync);
  });

  it("测试进程（Node）里导出的就是 node:fs", () => {
    expect(userFs.realpathSync).toBe(nodeFs.realpathSync);
    expect(userFsPromises).toBe(nodeFs.promises);
  });
});

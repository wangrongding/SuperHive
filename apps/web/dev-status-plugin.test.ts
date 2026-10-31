import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchProtocolOutput } from "./dev-status-plugin";

describe("watchProtocolOutput", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("reloads the page when the protocol dist directory is swapped out", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hive-protocol-"));
    const dist = path.join(root, "dist");
    mkdirSync(dist);
    writeFileSync(path.join(dist, "index.js"), "export const a = 1;");
    const module = { file: path.join(dist, "index.js") };
    const other = { file: path.join(root, "src", "App.tsx") };
    const invalidateModule = vi.fn();
    const send = vi.fn();
    stop = watchProtocolOutput(
      {
        moduleGraph: {
          idToModuleMap: new Map([
            ["a", module],
            ["b", other],
          ]),
          invalidateModule,
        },
        ws: { send },
      } as never,
      dist,
      20,
    );

    // 与 dev supervisor 一样：新产物在别处构建好，再整个目录换进来
    const staged = path.join(root, "build");
    mkdirSync(staged);
    writeFileSync(path.join(staged, "index.js"), "export const a = 1; export const b = 2;");
    renameSync(dist, path.join(root, "previous"));
    renameSync(staged, dist);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: "full-reload" }), {
      timeout: 2_000,
    });
    expect(invalidateModule).toHaveBeenCalledWith(module);
    expect(invalidateModule).not.toHaveBeenCalledWith(other);
    rmSync(root, { recursive: true, force: true });
  });
});

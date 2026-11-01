import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowedWorkspaceRoots, resolveRoomWorkspace } from "./workspace.js";

describe("房间工作区", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ws-")));
  const code = path.join(base, "Coding");
  const hive = path.join(code, "superhive");
  const other = path.join(code, "autoclaw");
  const outside = path.join(base, "secrets");
  for (const dir of [hive, other, outside]) mkdirSync(dir, { recursive: true });
  symlinkSync(outside, path.join(other, "escape"));
  const roots = allowedWorkspaceRoots(hive);

  it("默认允许启动目录及其上一级", () => {
    expect(roots).toEqual([hive, code]);
    expect(allowedWorkspaceRoots(hive, [outside])).toContain(outside);
  });

  it("允许范围内跟随；范围外、符号链接逃逸、不存在、只读都留在默认目录并说明", () => {
    const resolve = (
      roomWorkspace: string | undefined,
      access: "workspace" | "read-only" = "workspace",
    ) => resolveRoomWorkspace({ roomWorkspace, defaultCwd: hive, allowedRoots: roots, access });
    expect(resolve(undefined)).toEqual({ cwd: hive });
    expect(resolve(other)).toEqual({ cwd: other });
    expect(resolve(outside).note).toContain("不在你允许的目录范围内");
    expect(resolve(path.join(other, "escape"))).toMatchObject({ cwd: hive });
    expect(resolve(path.join(base, "nope")).note).toContain("不存在");
    expect(resolve(other, "read-only").note).toContain("只读");
  });
});

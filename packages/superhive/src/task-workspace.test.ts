import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTaskWorkspace,
  resolveTaskWorkspaces,
  sanitizeServerReason,
  TaskWorkspaceBusyError,
  TaskWorkspaceRemovedError,
} from "./task-workspace.js";
import { isServerUnavailable } from "./bridge.js";
import { AgentNonRetryableError } from "./responder.js";

const hive = { serverUrl: "http://hive", roomId: "general", username: "writer", token: "test" };
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "hive-workspace-resolution-")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const quickRetry = { attempts: 3, timeoutMs: 50, delaysMs: [1, 2], sleep: vi.fn(async () => {}) };

describe("task workspace resolution", () => {
  it("retries a busy or timed-out lookup with backoff and then selects the workspace", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          worktree: { path: directory, agentName: hive.username, roomId: hive.roomId },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    quickRetry.sleep.mockClear();
    expect(await resolveTaskWorkspace(hive, "message", quickRetry)).toBe(directory);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(quickRetry.sleep.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    () =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.resolve(new Response("busy", { status: 503 })),
    () => Promise.resolve(new Response("slow down", { status: 429 })),
  ])("gives a retryable busy result once retries run out", async (attempt) => {
    const fetch = vi.fn(attempt);
    vi.stubGlobal("fetch", fetch);
    const failure = resolveTaskWorkspaces(hive, ["first"], quickRetry);
    await expect(failure).rejects.toBeInstanceOf(TaskWorkspaceBusyError);
    await expect(failure).rejects.not.toBeInstanceOf(AgentNonRetryableError);
    expect(fetch).toHaveBeenCalledTimes(3);
    // 一轮跑完复核任务目录时，Bridge 对这些「忙」都要等 Server 回来再复核（故障单 3493d392：超时那种曾漏掉）
    expect(isServerUnavailable(await failure.catch((error: unknown) => error))).toBe(true);
  });

  it("fails at once, without retrying, when the server refuses the identity", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "unsafe" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  /** 不在线时的退避按假时钟走：sleep 推进时钟，不真的等 */
  function reconnectRetry() {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    return {
      retry: {
        attempts: 3,
        timeoutMs: 50,
        delaysMs: [2_000, 4_000],
        reconnectMs: 60_000,
        sleep,
        now: () => clock,
      },
      sleep,
    };
  }
  const offline = () => Response.json({ error: "Online local agent required" }, { status: 401 });

  it("waits for the Bridge to reconnect when the server has not seen it online yet", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(offline())
      .mockResolvedValueOnce(offline())
      .mockResolvedValueOnce(offline())
      .mockResolvedValueOnce(offline())
      .mockResolvedValueOnce(
        Response.json({
          worktree: { path: directory, agentName: hive.username, roomId: hive.roomId },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const { retry, sleep } = reconnectRetry();
    expect(await resolveTaskWorkspace(hive, "message", retry)).toBe(directory);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls).toEqual([[2_000], [4_000], [4_000], [4_000]]);
  });

  it("reports the 401 as before once the Bridge stays offline past the reconnect window", async () => {
    const fetch = vi.fn(async () => offline());
    vi.stubGlobal("fetch", fetch);
    const { retry, sleep } = reconnectRetry();
    const failure = resolveTaskWorkspaces(hive, ["first"], retry);
    await expect(failure).rejects.toBeInstanceOf(AgentNonRetryableError);
    await expect(failure).rejects.toThrow(
      "Cannot verify managed task workspace (401): Online local agent required",
    );
    const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(60_000);
    expect(waited).toBeGreaterThan(55_000);
  });

  it("does not wait on any other 401", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "Invalid token" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const { retry } = reconnectRetry();
    await expect(resolveTaskWorkspace(hive, "message", retry)).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("names the server's reason instead of only the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Task workspace /wt/a is now on feat/other", code: "WORKTREE_IDENTITY" },
          { status: 403 },
        ),
      ),
    );
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toThrow(
      "Cannot verify managed task workspace (403): WORKTREE_IDENTITY: Task workspace /wt/a is now on feat/other",
    );
  });

  it("keeps the server's reason when it answers busy, so the Bridge knows what it was waiting on", async () => {
    // Server 在限时内没查完任务目录（git 慢或排队等锁）时先回 503 和原因，比 Bridge 自己 17 秒超时先到
    const reason =
      "10 秒内没查完任务目录（git 太慢，或在排队等这个仓库别的任务目录操作），稍后再试";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: reason, code: "WORKTREE_GIT_LIMIT" }, { status: 503 }),
      ),
    );
    const failure = await resolveTaskWorkspaces(hive, ["first"], quickRetry).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TaskWorkspaceBusyError);
    expect((failure as TaskWorkspaceBusyError).reason).toBe(
      `Hive Server is busy (503): WORKTREE_GIT_LIMIT: ${reason} (after 3 attempts)`,
    );
  });

  it("hands the server's notice to the sink when the last task workspace was not reused", async () => {
    const reason = "任务目录 /wt/a 登记的分支是 feat/a，现在却在 feat/b";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("?messageId=")
          ? Response.json({
              worktree: null,
              notice: { kind: "focus_dropped", path: "/wt/a", reason },
            })
          : Response.json({
              worktrees: { first: null, second: null },
              notices: { first: { kind: "focus_dropped", path: "/wt/a", reason }, second: "junk" },
            }),
      ),
    );
    const single = vi.fn();
    expect(await resolveTaskWorkspace(hive, "message", quickRetry, single)).toBeUndefined();
    expect(single).toHaveBeenCalledWith("message", {
      kind: "focus_dropped",
      path: "/wt/a",
      reason,
    });
    const many = vi.fn();
    const selected = await resolveTaskWorkspaces(hive, ["first", "second"], quickRetry, many);
    expect([...selected.values()]).toEqual([undefined, undefined]);
    expect(many).toHaveBeenCalledOnce();
    expect(many).toHaveBeenCalledWith("first", { kind: "focus_dropped", path: "/wt/a", reason });
  });

  it("strips credentials and control characters from server reasons and caps their length", () => {
    const reason = sanitizeServerReason(
      "bad\u0000 Bearer abc.def token=s3cr3t HIVE_TOKEN=xyz sk-abcdefghijklmnop " +
        "aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgc2VjcmV0IHN0cmluZw " +
        "at /Users/me/repo-wt/a on feat/x commit 0123456789abcdef0123456789abcdef01234567",
    );
    expect(reason).not.toMatch(/abc\.def|s3cr3t|xyz|sk-abc|aGVsbG8/);
    expect(reason).not.toContain("\u0000");
    expect(reason).toContain("Bearer [redacted]");
    expect(reason).toContain("HIVE_TOKEN=[redacted]");
    expect(reason).toContain("/Users/me/repo-wt/a on feat/x");
    expect(reason).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(sanitizeServerReason("x".repeat(30) + " ".repeat(5) + "y ".repeat(400))).toHaveLength(
      400,
    );
  });

  it("fails at once when the returned checkout is foreign or has been replaced", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        worktree: {
          path: path.join(directory, "gone"),
          agentName: hive.username,
          roomId: hive.roomId,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("marks the after-turn re-check as settled so tasks finished mid-turn still verify", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ worktrees: { first: null, second: null } }),
    );
    vi.stubGlobal("fetch", fetch);
    await resolveTaskWorkspaces(hive, ["first", "second"], quickRetry);
    await resolveTaskWorkspaces(hive, ["first", "second"], quickRetry, undefined, {
      settled: true,
    });
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { messageIds: ["first", "second"] },
      { messageIds: ["first", "second"], settled: true },
    ]);
  });

  it("looks up a batch in one request and retains unbound entries", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        worktrees: {
          first: { path: directory, agentName: hive.username, roomId: hive.roomId },
          second: { path: directory, agentName: hive.username, roomId: hive.roomId },
          unbound: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const selected = await resolveTaskWorkspaces(hive, ["first", "second", "unbound"]);
    expect([...selected]).toEqual([
      ["first", directory],
      ["second", directory],
      ["unbound", undefined],
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://hive/api/agent/worktree",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ messageIds: ["first", "second", "unbound"] }),
      }),
    );
  });

  it.each([
    { worktrees: { first: null } },
    {
      worktrees: {
        first: null,
        second: { path: "/missing", agentName: "other", roomId: "general" },
      },
    },
  ])("refuses incomplete or foreign batch identities", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(resolveTaskWorkspaces(hive, ["first", "second"])).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
  });

  it("does not cache a selection across directory removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          worktree: {
            path: directory,
            agentName: hive.username,
            roomId: hive.roomId,
          },
        }),
      ),
    );
    expect(await resolveTaskWorkspace(hive, "first")).toBe(directory);
    await rm(directory, { recursive: true });
    await expect(resolveTaskWorkspace(hive, "first")).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
  });

  it("accepts only an authenticated removal receipt, including alongside live workspaces", async () => {
    const removed = {
      id: "00000000-0000-4000-8000-000000000000",
      path: "/missing",
      agentName: hive.username,
      roomId: hive.roomId,
      removed: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          worktree: removed,
          worktrees: {
            gone: removed,
            live: { path: directory, agentName: hive.username, roomId: hive.roomId },
          },
        }),
      ),
    );
    expect(await resolveTaskWorkspace(hive, "gone")).toBeInstanceOf(TaskWorkspaceRemovedError);
    const selected = await resolveTaskWorkspaces(hive, ["gone", "live"]);
    expect(selected.get("gone")).toBeInstanceOf(TaskWorkspaceRemovedError);
    expect(selected.get("live")).toBe(directory);
  });

  it.each([403, 404, 500])(
    "still refuses unverifiable HTTP %s without a cleanup receipt",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      await expect(resolveTaskWorkspace(hive, "gone")).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
      await expect(resolveTaskWorkspaces(hive, ["gone"])).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
    },
  );

  it("rejects a foreign or malformed removal receipt", async () => {
    for (const record of [
      {
        id: "invalid",
        path: "/missing",
        agentName: hive.username,
        roomId: hive.roomId,
        removed: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000000",
        path: "/missing",
        agentName: "other",
        roomId: hive.roomId,
        removed: true,
      },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ worktree: record })),
      );
      await expect(resolveTaskWorkspace(hive, "gone")).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
    }
  });
});

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessGate } from "./access-gate";

describe("AccessGate", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps retrying while the server is unreachable and moves on once it answers", async () => {
    vi.useFakeTimers();
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!up) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ role: "none", reason: "no_invite" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<AccessGate />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("连接失败")).toBeTruthy();
    expect(screen.getByText("正在自动重试，服务恢复后会直接进入。")).toBeTruthy();

    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("需要邀请")).toBeTruthy();
  });
});

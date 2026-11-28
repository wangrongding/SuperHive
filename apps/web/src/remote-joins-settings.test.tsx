// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteJoin } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { RemoteJoinsGroup } from "./remote-joins-settings";

afterEach(cleanup);

const join: RemoteJoin = {
  id: "j1",
  server: "http://10.0.0.8:8787",
  roomId: "build",
  name: "rd-claude",
  runtime: "claude",
  access: "full",
  cwd: null,
  model: null,
  pid: 42,
  background: true,
  status: "online",
  rooms: [{ roomId: "build", connected: true }],
  startedAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:00:00.000Z",
  stoppedAt: null,
  logFile: null,
  canRestart: true,
  lastError: null,
};

describe("带到别处的 Agent", () => {
  it("退出别人的房间先在确认弹窗里说清后果，取消就不动", async () => {
    const user = userEvent.setup();
    const removeRemoteJoin = vi.fn(async () => ({ left: true }));
    const local = {
      enabled: true,
      canManage: true,
      remoteJoins: async () => [join],
      removeRemoteJoin,
    } as unknown as LocalAgentsState;
    render(<RemoteJoinsGroup local={local} />);
    const leave = await screen.findByRole("button", { name: "退出房间" });

    await user.click(leave);
    let dialog = await screen.findByRole("alertdialog", {
      name: "让 rd-claude 退出 10.0.0.8:8787 的房间？",
    });
    expect(dialog.textContent).toContain("要再加入得对方重新邀请");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removeRemoteJoin).not.toHaveBeenCalled();

    await user.click(leave);
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "退出房间" }));
    await waitFor(() => expect(removeRemoteJoin).toHaveBeenCalledWith("j1", true));
  });
});

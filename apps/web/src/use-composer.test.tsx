// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopBridge, type DesktopPickedFile } from "./desktop-bridge";
import { pickedToFiles } from "./desktop-files";
import { useComposer } from "./use-composer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.superhiveDesktop;
});

/** 记录发出的上传请求，不真的发 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url = "";
  body: FormData | undefined;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    this.body = body;
  }
  abort() {}
}

const terminal = Object.fromEntries(
  ["create", "write", "resize", "kill", "onData", "onExit", "onNewRequest"].map((name) => [
    name,
    () => () => undefined,
  ]),
);

function renderComposer(roomId = "build") {
  return renderHook(() =>
    useComposer({
      username: "rd",
      currentRoomId: roomId,
      participants: [],
      messages: [],
      invocations: new Map(),
      autoSaveDraft: false,
      sendShortcut: "enter",
      richComposer: false,
      currentLeadAgent: undefined,
      base: "http://hive",
      authToken: "t",
      socketRef: { current: undefined },
    }),
  );
}

function fileInput() {
  const input = document.createElement("input");
  input.type = "file";
  const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
  return { input, click };
}

describe("附件按钮选文件", () => {
  it("浏览器里照旧点开 <input type=file>", () => {
    const { result } = renderComposer();
    const { input, click } = fileInput();
    result.current.fileInputRef.current = input;
    act(() => result.current.openFilePicker());
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("桌面端走系统选文件窗口：只给房间 ID，读回来的文件进上传队列，不再点 input", async () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const pick = vi.fn(async () => ({
      canceled: false,
      files: [
        {
          name: "notes.md",
          type: "text/markdown",
          size: 5,
          data: new TextEncoder().encode("hello"),
        },
      ],
    }));
    window.superhiveDesktop = { version: 1, platform: "darwin", terminal, files: { pick } };
    const { result } = renderComposer("build");
    const { input, click } = fileInput();
    result.current.fileInputRef.current = input;
    act(() => result.current.openFilePicker());
    expect(pick).toHaveBeenCalledWith({ roomId: "build", multiple: true });
    await waitFor(() => expect(result.current.attachmentQueue.items).toHaveLength(1));
    expect(click).not.toHaveBeenCalled();
    const item = result.current.attachmentQueue.items[0]!;
    expect(item.name).toBe("notes.md");
    expect(item.size).toBe(5);
    expect(FakeXhr.instances[0]?.url).toBe("http://hive/api/rooms/build/attachments");
    const sent = FakeXhr.instances[0]?.body?.get("file") as File;
    expect(sent.type).toBe("text/markdown");
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(sent);
    });
    expect(text).toBe("hello");
  });

  it("桌面端取消时什么都不加；超出上限没读的照常提示", async () => {
    const pick = vi
      .fn()
      .mockResolvedValueOnce({ canceled: true, files: [] })
      .mockResolvedValueOnce({
        canceled: false,
        files: [{ name: "huge.iso", type: "", size: 30 * 1024 * 1024, skipped: "too-large" }],
      });
    window.superhiveDesktop = { version: 1, platform: "darwin", terminal, files: { pick } };
    const { result } = renderComposer();
    await act(async () => result.current.openFilePicker());
    expect(result.current.attachmentQueue.items).toHaveLength(0);
    expect(result.current.attachmentNotice).toBeUndefined();
    await act(async () => result.current.openFilePicker());
    await waitFor(() => expect(result.current.attachmentNotice).toContain("huge.iso"));
    expect(result.current.attachmentQueue.items).toHaveLength(0);
  });

  it("桌面端这条路出错（比如来源校验没过）时退回 <input type=file>", async () => {
    const pick = vi.fn(async () => {
      throw new Error("Forbidden");
    });
    window.superhiveDesktop = { version: 1, platform: "darwin", terminal, files: { pick } };
    const { result } = renderComposer();
    const { input, click } = fileInput();
    result.current.fileInputRef.current = input;
    act(() => result.current.openFilePicker());
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  });

  it("老版本桌面端没有 files：照旧点 input；形状不对的 files 被丢掉，终端不受影响", () => {
    window.superhiveDesktop = { version: 1, platform: "darwin", terminal };
    const { result } = renderComposer();
    const { input, click } = fileInput();
    result.current.fileInputRef.current = input;
    act(() => result.current.openFilePicker());
    expect(click).toHaveBeenCalledTimes(1);

    const bridge = desktopBridge({ version: 1, platform: "darwin", terminal, files: { pick: 1 } });
    expect(bridge?.terminal).toBe(terminal);
    expect(bridge?.files).toBeUndefined();
  });
});

describe("pickedToFiles", () => {
  it("读了的变成 File，没读的按原因给提示", () => {
    const picked: DesktopPickedFile[] = [
      { name: "a.png", type: "image/png", size: 2, data: new Uint8Array([1, 2]) },
      { name: "b.bin", type: "", size: 1, skipped: "count" },
    ];
    const { files, notice } = pickedToFiles(picked);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("a.png");
    expect(files[0]?.type).toBe("image/png");
    expect(notice).toContain("10");
    expect(pickedToFiles([{ name: "c", type: "", size: 1, skipped: "total" }]).notice).toContain(
      "50 MB",
    );
    expect(pickedToFiles([]).notice).toBeUndefined();
  });
});

describe("插件的 / 命令", () => {
  it("插件认领的命令不发出去、清空输入框；没认领的照常发", () => {
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    const intercept = vi.fn((content: string) => content.startsWith("/roll"));
    const { result } = renderHook(() =>
      useComposer({
        username: "rd",
        currentRoomId: "build",
        participants: [],
        messages: [],
        invocations: new Map(),
        autoSaveDraft: false,
        sendShortcut: "enter",
        richComposer: false,
        currentLeadAgent: undefined,
        base: "http://hive",
        authToken: "t",
        socketRef: { current: socket },
        interceptCommand: intercept,
      }),
    );
    act(() => result.current.setDraft("/roll 2d6"));
    act(() => result.current.sendMessage());
    expect(intercept).toHaveBeenCalledWith("/roll 2d6");
    expect(send).not.toHaveBeenCalled();
    expect(result.current.draft).toBe("");
    act(() => result.current.setDraft("/unknown 你好"));
    act(() => result.current.sendMessage());
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
      content: "/unknown 你好",
    });
  });
});

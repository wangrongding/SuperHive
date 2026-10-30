// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerAttachments,
  formatBytes,
  nameForPastedFile,
  useAttachmentQueue,
  type QueuedAttachment,
} from "./attachments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 记录发出的上传请求，由测试决定何时完成 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = {
    onprogress: null as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | undefined;
  aborted = false;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe("附件上传队列", () => {
  it("凭证放在请求头里；上传完成后才交出附件 ID；失败可重试", () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    );
    const { result } = renderHook(() =>
      useAttachmentQueue({ base: "http://hive", token: "secret", roomId: "general" }),
    );
    act(() => {
      result.current.add([new File(["hello"], "a.txt", { type: "text/plain" })]);
    });
    const request = FakeXhr.instances[0]!;
    expect(request.url).toBe("http://hive/api/rooms/general/attachments");
    expect(request.url).not.toContain("secret");
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(result.current.uploading).toBe(true);
    expect(result.current.readyIds).toEqual([]);

    act(() => request.respond(500, { error: "磁盘满了" }));
    expect(result.current.failed).toBe(true);
    expect(result.current.items[0]?.error).toBe("磁盘满了");

    act(() => result.current.retry(result.current.items[0]!.localId));
    const second = FakeXhr.instances[1]!;
    act(() => second.respond(201, { id: "att-1", name: "a.txt", kind: "text" }));
    expect(result.current.readyIds).toEqual(["att-1"]);
    expect(result.current.failed).toBe(false);
  });

  it("超过单个文件或件数上限的不加入，并给出提示", () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { result } = renderHook(() =>
      useAttachmentQueue({ base: "http://hive", token: "t", roomId: "general" }),
    );
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    let notice: string | undefined;
    act(() => {
      notice = result.current.add([big]);
    });
    expect(notice).toContain("超过 20 MB");
    expect(result.current.items).toHaveLength(0);
    act(() => {
      notice = result.current.add(
        Array.from({ length: 12 }, (_, index) => new File(["x"], `f${index}.txt`)),
      );
    });
    expect(result.current.items).toHaveLength(10);
    expect(notice).toContain("最多 10 个");
  });
});

describe("待发附件", () => {
  it("显示进度、失败原因，可移除与重试", () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const file = new File(["x"], "notes.md");
    const items: QueuedAttachment[] = [
      { localId: "1", file, name: "notes.md", size: 2048, status: "uploading", progress: 0.4 },
      {
        localId: "2",
        file,
        name: "bad.md",
        size: 10,
        status: "error",
        progress: 0,
        error: "没有上传权限",
      },
    ];
    render(<ComposerAttachments items={items} onRemove={onRemove} onRetry={onRetry} />);
    expect(screen.getByText("上传中 40%")).toBeTruthy();
    expect(screen.getByText("没有上传权限")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试上传 bad.md" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 notes.md" }));
    expect(onRetry).toHaveBeenCalledWith("2");
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("剪贴板截图起一个可读的名字；普通文件名保留", () => {
    expect(nameForPastedFile(new File(["x"], "image.png", { type: "image/png" }), 0)).toMatch(
      /^粘贴图片-\d{8}-\d{6}\.png$/,
    );
    expect(nameForPastedFile(new File(["x"], "设计稿.jpg", { type: "image/jpeg" }), 0)).toBe(
      "设计稿.jpg",
    );
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

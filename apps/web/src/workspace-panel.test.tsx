// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceDiff,
  WorkspaceOverview,
  WorkspaceStatus,
  WorkspaceTree,
} from "@superhive/protocol";
import { WorkspacePanel, defaultSource, sortSources, type WorkspaceApi } from "./workspace-panel";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const overview: WorkspaceOverview = {
  configured: true,
  name: "hive",
  git: true,
  changeCount: 3,
  guestsAllowed: false,
  canReveal: true,
  sources: [{ id: "workspace", kind: "workspace", label: "hive", branch: "main" }],
};

const status: WorkspaceStatus = {
  git: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  changes: [
    { path: "src/app.ts", group: "unstaged", status: "M", additions: 1, deletions: 1 },
    { path: "README.md", group: "staged", status: "A", additions: 2, deletions: 0 },
    { path: ".env", group: "untracked", status: "?", additions: 1, sensitive: true },
  ],
};

const longPatch = [
  "@@ -1,16 +1,16 @@",
  ...Array.from({ length: 10 }, (_, index) => ` line${index + 1}`),
  "-const value = 1;",
  "+const value = 2;",
  ...Array.from({ length: 5 }, (_, index) => ` line${index + 12}`),
  "",
].join("\n");

type Handler = (query: Record<string, string | undefined>) => unknown;

function fakeApi(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    "": () => overview,
    "/status": () => status,
    "/diff": (query) =>
      query.path === ".env" && !query.reveal
        ? ({ path: ".env", sensitive: true } satisfies WorkspaceDiff)
        : query.path === ".env"
          ? { path: ".env", sensitive: true, patch: "@@ -0,0 +1 @@\n+TOKEN=1\n", full: true }
          : { path: query.path!, patch: longPatch, full: true },
    "/tree": (query) =>
      ({
        path: query.path ?? "",
        entries:
          (query.path ?? "") === ""
            ? [
                { name: "src", path: "src", type: "directory", status: "M" },
                { name: "README.md", path: "README.md", type: "file", size: 12 },
              ]
            : [{ name: "app.ts", path: "src/app.ts", type: "file", size: 20, status: "M" }],
      }) satisfies WorkspaceTree,
    "/file": (query) => ({ path: query.path, size: 20, content: "const a = 1;\nconst b = 2;\n" }),
    "/log": () => ({ commits: [] }),
    "/raw-url": (query) => ({
      url: `/raw?t=${query.ref}:${query.path}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      size: 10,
      contentType: "image/png",
      inline: true,
    }),
    ...overrides,
  };
  const api = vi.fn(async (path: string, query: Record<string, string | undefined> = {}) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler(query);
  });
  return api as typeof api & WorkspaceApi;
}

function open(api: WorkspaceApi, props: Partial<Parameters<typeof WorkspacePanel>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <WorkspacePanel
      api={api}
      roomId="general"
      workspaceConfigured
      isOwner
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

describe("WorkspacePanel", () => {
  it("房间没设工作区：给出说明和去设置的入口，不发请求", async () => {
    const api = fakeApi();
    const onOpenSettings = vi.fn();
    open(api, { workspaceConfigured: false, onOpenSettings });
    expect(screen.getByText("这个房间还没有设工作区。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "去设置工作区" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("按已暂存 / 未暂存 / 未跟踪分组列出改动，带分支与领先数，自动打开第一个文件的 diff", async () => {
    const api = fakeApi();
    const onOverview = vi.fn();
    open(api, { onOverview });
    const list = await screen.findByLabelText("改动的文件");
    const groups = (await within(list).findAllByRole("heading", { level: 3 })).map(
      (heading) => heading.textContent,
    );
    expect(groups).toEqual(["已暂存1", "未暂存1", "未跟踪1"]);
    expect(within(list).getByText("main")).toBeTruthy();
    expect(within(list).getByText("↑2")).toBeTruthy();
    expect(within(list).getByTitle("可能含密钥")).toBeTruthy();
    expect(onOverview).toHaveBeenCalledWith(expect.objectContaining({ changeCount: 3 }));
    // 第一个是已暂存的 README.md
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({ path: "README.md", mode: "staged", full: "1" }),
      ),
    );
    expect(await screen.findByRole("table", { name: "README.md 的改动" })).toBeTruthy();
  });

  it("diff：折叠未改动、全部展开、切换左右对照并记住选择", async () => {
    const api = fakeApi();
    open(api);
    const table = await screen.findByRole("table", { name: "README.md 的改动" });
    expect(within(table).getByRole("button", { name: "展开 7 行未改动" })).toBeTruthy();
    expect(within(table).queryByText("line1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(within(table).getByText("line1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "折叠未改动" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await userEvent.click(screen.getByRole("radio", { name: "左右对照" }));
    expect(localStorage.getItem("superhive.workspace-diff-view")).toBe("split");
    const split = screen.getByRole("table", { name: "README.md 的改动" });
    expect(split.classList.contains("split")).toBe(true);
    // 删除和新增配成同一行：左边旧值、右边新值
    const row = within(split)
      .getAllByRole("row")
      .find((item) => item.textContent?.includes("const value = 1;"));
    expect(row?.textContent).toContain("const value = 2;");
  });

  it("自动换行：文本文件默认换行、代码默认不换行，两类分别记住；左右对照固定换行", async () => {
    const api = fakeApi();
    open(api);
    const readme = await screen.findByRole("table", { name: "README.md 的改动" });
    expect(readme.classList.contains("wrap")).toBe(true);
    const toggle = () => screen.getByRole("button", { name: "自动换行" });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("table", { name: "README.md 的改动" }).classList.contains("wrap")).toBe(
      false,
    );
    expect(localStorage.getItem("superhive.workspace-wrap.prose")).toBe("0");

    // 代码文件按自己的默认值：不换行
    await userEvent.click(
      within(screen.getByLabelText("改动的文件")).getByRole("button", { name: /app\.ts/ }),
    );
    const code = await screen.findByRole("table", { name: "src/app.ts 的改动" });
    expect(code.classList.contains("wrap")).toBe(false);
    await userEvent.click(toggle());
    expect(
      screen.getByRole("table", { name: "src/app.ts 的改动" }).classList.contains("wrap"),
    ).toBe(true);
    expect(localStorage.getItem("superhive.workspace-wrap.code")).toBe("1");
    await userEvent.click(toggle());

    // 左右对照两边各占一半，总是换行，开关锁住
    await userEvent.click(screen.getByRole("radio", { name: "左右对照" }));
    const split = screen.getByRole("table", { name: "src/app.ts 的改动" });
    expect(split.classList.contains("wrap")).toBe(true);
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(toggle());
    expect(localStorage.getItem("superhive.workspace-wrap.code")).toBe("0");
  });

  it("文件预览也有自动换行开关，按文件类型给默认值", async () => {
    localStorage.setItem("superhive.workspace-wrap.code", "1");
    const api = fakeApi();
    open(api);
    await userEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    await userEvent.click(await screen.findByRole("button", { name: /^README\.md/ }));
    // .md 默认按文档排版看，这时没有换行开关；切到源码才是带行号的表格
    await waitFor(() => expect(document.querySelector(".doc-markdown")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(screen.queryByRole("button", { name: "自动换行" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "看源码" }));
    const readme = await screen.findByRole("table", { name: "README.md" });
    expect(readme.classList.contains("wrap")).toBe(true);
    expect(screen.getByRole("button", { name: "看渲染" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "自动换行" }));
    expect(screen.getByRole("table", { name: "README.md" }).classList.contains("wrap")).toBe(false);
    // 代码文件用记住的选择（之前切成了换行）
    await userEvent.click(await screen.findByRole("button", { name: /^src/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^app\.ts/ }));
    const code = await screen.findByRole("table", { name: "src/app.ts" });
    expect(code.classList.contains("wrap")).toBe(true);
  });

  it("疑似密钥文件：默认不显示，房主确认后带 reveal 再取", async () => {
    const api = fakeApi();
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: /\.env/ }));
    expect(await screen.findByText("这个文件可能含有密钥，默认不显示内容。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "显示内容…" }));
    await userEvent.click(screen.getByRole("button", { name: "确认显示" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({ path: ".env", reveal: "1" }),
      ),
    );
    expect(await screen.findByText("TOKEN=1")).toBeTruthy();
  });

  it("不能查看密钥的人只看到说明", async () => {
    const api = fakeApi({ "": () => ({ ...overview, canReveal: false }) });
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: /\.env/ }));
    expect(await screen.findByText("只有房主可以查看。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "显示内容…" })).toBeNull();
  });

  it("文件树懒加载：展开目录才取下一层，点文件只读预览", async () => {
    const api = fakeApi();
    open(api);
    await userEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    const src = await screen.findByRole("button", { name: /^src/ });
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(api).not.toHaveBeenCalledWith("/tree", expect.objectContaining({ path: "src" }));
    await userEvent.click(src);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(await screen.findByRole("button", { name: /^app\.ts/ }));
    expect(api).toHaveBeenCalledWith("/tree", expect.objectContaining({ path: "src" }));
    const preview = await screen.findByRole("table", { name: "src/app.ts" });
    expect(within(preview).getAllByRole("row")).toHaveLength(2);
    // 切换显示被忽略的文件会带上 ignored=1 重新取
    await userEvent.click(screen.getByRole("checkbox", { name: "显示被 .gitignore 忽略的文件" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/tree",
        expect.objectContaining({ path: "", ignored: "1" }),
      ),
    );
  });

  it("面板打开时定时刷新状态，Esc 关闭", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const { onClose } = open(api);
    await screen.findByLabelText("改动的文件");
    const before = api.mock.calls.filter(([path]) => path === "/status").length;
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    await waitFor(() =>
      expect(api.mock.calls.filter(([path]) => path === "/status").length).toBeGreaterThan(before),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("有 worktree 时可以切换来源，默认看相对 base 的改动", async () => {
    const worktreeId = "00000000-0000-4000-8000-0000000000aa";
    const api = fakeApi({
      "": () => ({
        ...overview,
        sources: [
          ...overview.sources,
          {
            id: worktreeId,
            kind: "worktree",
            label: "feat/x",
            branch: "feat/x",
            agentName: "helper",
            base: "main",
          },
        ],
      }),
      "/compare": () => ({
        base: "main",
        mergeBase: "abc",
        commits: [{ hash: "a", shortHash: "a", subject: "work", author: "h", date: "" }],
        changes: [{ path: "src/x.ts", group: "unstaged", status: "M", additions: 3, deletions: 0 }],
      }),
    });
    open(api);
    await userEvent.click(await screen.findByRole("combobox", { name: "查看哪份代码" }));
    await userEvent.click(await screen.findByRole("option", { name: /feat\/x/ }));
    expect(await screen.findByText("1 个提交 · 1 个文件")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/compare", { source: worktreeId, base: "main" });
    expect(screen.getByRole("radio", { name: "相对 main" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({
          source: worktreeId,
          path: "src/x.ts",
          mode: "base",
          base: "main",
        }),
      ),
    );
  });

  it("加载失败时显示服务端说明并可重试", async () => {
    let fail = true;
    const api = fakeApi({
      "": () => {
        if (fail) throw new Error("房主没有开放工作区文件查看。");
        return overview;
      },
    });
    open(api);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("房主没有开放工作区文件查看。"),
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("改动的文件")).toBeTruthy();
  });

  it("图片改动显示改前改后对照，新增图片只显示改后", async () => {
    const api = fakeApi({
      "/status": () => ({
        git: true,
        branch: "main",
        changes: [
          { path: "logo.png", group: "unstaged", status: "M", binary: true },
          { path: "new.png", group: "untracked", status: "?", binary: true },
        ],
      }),
      "/diff": (query) => ({ path: query.path, binary: true }),
    });
    open(api);
    expect(await screen.findByText("改前")).toBeTruthy();
    const images = await screen.findAllByRole<HTMLImageElement>("img");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/raw?t=index:logo.png",
      "/raw?t=worktree:logo.png",
    ]);
    expect(screen.queryByRole("radio", { name: "左右对照" })).toBeNull();
    await userEvent.click(
      within(screen.getByLabelText("改动的文件")).getByRole("button", { name: /new\.png/ }),
    );
    expect(await screen.findByText("新增")).toBeTruthy();
    expect(screen.queryByText("改前")).toBeNull();
  });

  it("文件树：图片直接预览、SVG 可切到源码，其他二进制给下载", async () => {
    const api = fakeApi({
      "/tree": () => ({
        path: "",
        entries: [
          { name: "icon.svg", path: "icon.svg", type: "file", size: 30 },
          { name: "tool.bin", path: "tool.bin", type: "file", size: 30 },
        ],
      }),
      "/file": (query) =>
        query.path === "tool.bin"
          ? { path: "tool.bin", size: 30, binary: true }
          : { path: query.path, size: 30, content: "<svg></svg>\n" },
    });
    open(api);
    await userEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    await userEvent.click(await screen.findByRole("button", { name: /^icon\.svg/ }));
    expect((await screen.findByRole("img", { name: "icon.svg" })).getAttribute("src")).toBe(
      "/raw?t=worktree:icon.svg",
    );
    expect(api).not.toHaveBeenCalledWith("/file", expect.objectContaining({ path: "icon.svg" }));
    await userEvent.click(screen.getByRole("button", { name: "看源码" }));
    expect(await screen.findByRole("table", { name: "icon.svg" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^tool\.bin/ }));
    expect(await screen.findByText("二进制文件，不能在这里预览。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
  });

  it("Office 文档：文件树里直接预览，CSV 可切到源码；改动里 CSV 先看文本 diff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("城市,温度\n上海,18.5\n")),
    );
    try {
      const api = fakeApi({
        "/status": () => ({
          git: true,
          branch: "main",
          changes: [
            { path: "weather.csv", group: "unstaged", status: "M", additions: 1, deletions: 0 },
          ],
        }),
        "/diff": (query) => ({
          path: query.path,
          patch: "@@ -1,1 +1,2 @@\n 城市,温度\n+上海,18.5\n",
          full: true,
        }),
        "/tree": () => ({
          path: "",
          entries: [{ name: "weather.csv", path: "weather.csv", type: "file", size: 30 }],
        }),
        "/file": (query) => ({ path: query.path, size: 30, content: "城市,温度\n上海,18.5\n" }),
      });
      open(api);
      // 改动：CSV 默认文本 diff，可切到预览对照
      expect(await screen.findByText("上海,18.5")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "看预览对照" }));
      expect(await screen.findByRole("button", { name: "看文本 diff" })).toBeTruthy();
      expect(
        await screen.findAllByRole("table", { name: "Sheet1" }, { timeout: 10_000 }),
      ).toHaveLength(2);

      await userEvent.click(screen.getByRole("tab", { name: "文件树" }));
      await userEvent.click(await screen.findByRole("button", { name: /^weather\.csv/ }));
      expect(
        (await screen.findByRole("table", { name: "Sheet1" }, { timeout: 10_000 })).textContent,
      ).toContain("18.5");
      expect(api).not.toHaveBeenCalledWith(
        "/file",
        expect.objectContaining({ path: "weather.csv" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "看源码" }));
      expect(await screen.findByRole("table", { name: "weather.csv" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "看表格" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("默认打开最近有改动、还没合入的任务线；手动选过的下次记住；「看改动」切到那个 Agent", async () => {
    const recent = "00000000-0000-4000-8000-0000000000b1";
    const older = "00000000-0000-4000-8000-0000000000b2";
    const merged = "00000000-0000-4000-8000-0000000000b3";
    const api = fakeApi({
      "": () => ({
        ...overview,
        changeCount: 0,
        sources: [
          { id: "workspace", kind: "workspace", label: "hive", branch: "main", changeCount: 0 },
          {
            id: merged,
            kind: "worktree",
            label: "feat/done",
            agentName: "alpha",
            base: "main",
            merged: true,
            activeAt: "2026-11-19T10:00:00.000Z",
          },
          {
            id: older,
            kind: "worktree",
            label: "feat/older",
            agentName: "beta",
            base: "main",
            changeCount: 1,
            activeAt: "2026-11-19T08:00:00.000Z",
          },
          {
            id: recent,
            kind: "worktree",
            label: "feat/recent",
            agentName: "gamma",
            base: "main",
            ahead: 2,
            activeAt: "2026-11-19T09:00:00.000Z",
          },
        ],
      }),
      "/compare": () => ({ base: "main", mergeBase: "abc", commits: [], changes: [] }),
    });
    const { unmount } = render(
      <WorkspacePanel
        api={api}
        roomId="general"
        workspaceConfigured
        isOwner
        onClose={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/compare", expect.objectContaining({ source: recent })),
    );
    expect(api).toHaveBeenCalledWith("", { detail: "1" });
    // 下拉里按最近改动排，已合入的在最后并标出来
    await userEvent.click(screen.getByRole("combobox", { name: "查看哪份代码" }));
    const options = screen.getAllByRole("option").map((item) => item.textContent ?? "");
    expect(options[1]).toContain("feat/recent");
    expect(options[1]).toContain("领先 2 个提交");
    expect(options[2]).toContain("1 个文件未提交");
    expect(options[3]).toContain("已合入");
    await userEvent.click(screen.getByRole("option", { name: /feat\/older/ }));
    expect(localStorage.getItem("superhive.workspace-source:general")).toBe(older);
    unmount();

    api.mockClear();
    const { rerender } = render(
      <WorkspacePanel
        api={api}
        roomId="general"
        workspaceConfigured
        isOwner
        onClose={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/compare", expect.objectContaining({ source: older })),
    );
    rerender(
      <WorkspacePanel
        api={api}
        roomId="general"
        workspaceConfigured
        isOwner
        onClose={() => undefined}
        focus={{ agent: "GAMMA", nonce: 1 }}
      />,
    );
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith("/compare", expect.objectContaining({ source: recent })),
    );
  });
});

describe("从消息里的提交号打开", () => {
  it("切到「最近提交」并直接打开那个提交", async () => {
    const api = fakeApi({
      "/commit": (query) => ({
        commit: {
          hash: query.commit,
          shortHash: "6c28c9a",
          subject: "媒体预览",
          author: "rd",
          date: "",
        },
        changes: [{ path: "logo.png", group: "unstaged", status: "A", binary: true }],
      }),
    });
    render(
      <WorkspacePanel
        api={api}
        roomId="general"
        workspaceConfigured
        isOwner
        onClose={() => undefined}
        focus={{ source: "workspace", commit: "6c28c9a0f1e2", nonce: 1 }}
      />,
    );
    expect(
      (await screen.findByRole("tab", { name: "最近提交" })).getAttribute("aria-selected"),
    ).toBe("true");
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/commit", { source: "workspace", commit: "6c28c9a0f1e2" }),
    );
    expect(await screen.findByText("媒体预览")).toBeTruthy();
  });
});

describe("defaultSource", () => {
  const worktree = (id: string, extra: object = {}) => ({
    id: `00000000-0000-4000-8000-00000000000${id}`,
    kind: "worktree" as const,
    label: id,
    ...extra,
  });
  it("工作区有未提交改动就先看工作区；都没改动看工作区", () => {
    const sources = [
      { id: "workspace", kind: "workspace" as const, label: "hive", changeCount: 2 },
      worktree("1", { activeAt: "2026-11-19T09:00:00.000Z", changeCount: 1 }),
    ];
    expect(defaultSource(sources)).toBe("workspace");
    expect(
      defaultSource([
        { id: "workspace", kind: "workspace", label: "hive" },
        worktree("2", { merged: true }),
      ]),
    ).toBe("workspace");
  });

  it("记住的选择已合入或被清理时重新挑；找不到 Agent 的任务线就看工作区", () => {
    const live = worktree("3", { activeAt: "2026-11-19T09:00:00.000Z", agentName: "beta" });
    const done = worktree("4", { merged: true, agentName: "alpha" });
    const sources = [{ id: "workspace", kind: "workspace" as const, label: "hive" }, done, live];
    expect(defaultSource(sources, { remembered: done.id })).toBe(live.id);
    expect(defaultSource(sources, { remembered: "gone" })).toBe(live.id);
    expect(defaultSource(sources, { agent: "nobody" })).toBe("workspace");
    expect(defaultSource(sources, { agent: "alpha" })).toBe(done.id);
    expect(sortSources(sources).map((item) => item.id)).toEqual(["workspace", live.id, done.id]);
  });
});

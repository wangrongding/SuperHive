// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS_BASE_URL } from "@superhive/protocol";
import { setLocalePreference } from "./i18n";
import { DESKTOP_DOWNLOAD_URL, RoomSidebar } from "./room-sidebar";

afterEach(cleanup);

type Props = ComponentProps<typeof RoomSidebar>;

function props(patch: Partial<Props> = {}): Props {
  return {
    activeRoomCount: 0,
    attention: { items: [], open: vi.fn() } as unknown as Props["attention"],
    attentionGroup: true,
    closeMobilePanel: vi.fn(),
    connectionState: "online",
    freezeRoomList: vi.fn(),
    incidentAttention: [],
    incidentEntry: undefined,
    isOwner: true,
    mobilePanel: undefined,
    modifierKeyLabel: "Cmd",
    openActivity: vi.fn(),
    openRoomDialog: vi.fn(),
    panelWidths: { rooms: 240, members: 240, preview: 480 },
    renderRoomItem: () => null,
    resizePanel: vi.fn(),
    roomNameOf: (id) => id,
    roomReorder: {
      dragging: false,
      scrollRef: createRef(),
      listRef: createRef(),
    } as unknown as Props["roomReorder"],
    roomsCloseRef: createRef(),
    scheduleCounts: { pending: 0, attention: 0 },
    openSchedules: vi.fn(),
    setImDialogOpen: vi.fn(),
    setMobilePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
    setShowArchivedRooms: vi.fn(),
    setThemePreference: vi.fn(),
    setUserMenuOpen: vi.fn(),
    setUsername: vi.fn(),
    settingsTriggerRef: createRef(),
    showArchivedRooms: false,
    sidebarRooms: { pinned: [], others: [] },
    taskCounts: { attention: 0, inFlight: 0 },
    thawRoomList: vi.fn(),
    themePreference: "system",
    unreadMentionCount: 0,
    userMenuHoverTimer: { current: undefined },
    userMenuOpen: false,
    userMenuRef: createRef(),
    username: "rd",
    ...patch,
  };
}

describe("sidebar incident entry", () => {
  it("keeps the identity menu and feedback as independent accessible buttons", () => {
    const openFeedback = vi.fn();
    const setUserMenuOpen = vi.fn();
    const { rerender } = render(<RoomSidebar {...props({ openFeedback, setUserMenuOpen })} />);
    const menu = screen.getByRole("button", { name: "用户菜单" });
    const feedback = screen.getByRole("button", { name: "反馈问题 / 建议功能" });
    expect(menu.contains(feedback)).toBe(false);
    expect(menu.querySelector(".icon")).toBeNull();
    fireEvent.click(feedback);
    expect(openFeedback).toHaveBeenCalledTimes(1);
    expect(setUserMenuOpen).not.toHaveBeenCalled();
    fireEvent.click(menu);
    expect(setUserMenuOpen).toHaveBeenCalled();
    rerender(<RoomSidebar {...props({ openFeedback, userMenuOpen: true })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "反馈问题 / 建议功能" }));
    expect(openFeedback).toHaveBeenCalledTimes(2);
  });
  it("keeps the menu open when the click right after hovering would otherwise close it", () => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => ({ matches: query === "(hover: hover)" }) as MediaQueryList);
    try {
      const setUserMenuOpen = vi.fn();
      const { container, rerender } = render(<RoomSidebar {...props({ setUserMenuOpen })} />);
      fireEvent.mouseEnter(container.querySelector(".sidebar-user")!);
      expect(setUserMenuOpen).toHaveBeenLastCalledWith(true);
      rerender(<RoomSidebar {...props({ setUserMenuOpen, userMenuOpen: true })} />);
      // 鼠标移上来就展开了，用户顺手再点一下头像：仍然开着，不是 toggle 关掉
      fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
      expect(setUserMenuOpen).toHaveBeenLastCalledWith(true);
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("isn't there unless the page is the owner's on this computer", () => {
    render(<RoomSidebar {...props()} />);
    expect(screen.getByRole("button", { name: "Agent 任务" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^故障/ })).toBeNull();
  });

  it("sits with the quick actions, with a count only when something needs handling", () => {
    const open = vi.fn();
    const { rerender } = render(<RoomSidebar {...props({ incidentEntry: { count: 0, open } })} />);
    const quick = screen.getByRole("navigation", { name: "快捷操作" });
    const entry = screen.getByRole("button", { name: "故障" });
    expect(quick.contains(entry)).toBe(true);
    expect(entry.querySelector(".sidebar-badge")).toBeNull();
    fireEvent.click(entry);
    expect(open).toHaveBeenCalledWith(entry);

    rerender(<RoomSidebar {...props({ incidentEntry: { count: 3, open } })} />);
    const counted = screen.getByRole("button", { name: "故障，3 条待处理" });
    expect(counted.querySelector(".sidebar-badge")?.textContent).toBe("3");
  });

  it("opens the escalated incident from 「需要你处理」", () => {
    const open = vi.fn();
    render(
      <RoomSidebar
        {...props({
          incidentEntry: { count: 1, open },
          incidentAttention: [{ id: "i1", kind: "incident", title: "TypeError: escalated" }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /TypeError: escalated/ }));
    expect(open).toHaveBeenCalledWith(undefined, "i1");
  });
});

describe("sidebar schedules entry", () => {
  it("sits with Agent tasks for everyone, guests included, and opens the panel", () => {
    const openSchedules = vi.fn();
    render(<RoomSidebar {...props({ isOwner: false, openSchedules })} />);
    const quick = screen.getByRole("navigation", { name: "快捷操作" });
    const entry = screen.getByRole("button", { name: "定时任务" });
    expect(quick.contains(entry)).toBe(true);
    // 紧跟在「Agent 任务」后面
    const actions: HTMLElement[] = [...quick.querySelectorAll("button")];
    expect(actions.indexOf(entry)).toBe(
      actions.indexOf(screen.getByRole("button", { name: "Agent 任务" })) + 1,
    );
    expect(entry.getAttribute("aria-haspopup")).toBe("dialog");
    expect(entry.querySelector(".sidebar-badge")).toBeNull();
    fireEvent.click(entry);
    expect(openSchedules).toHaveBeenCalledWith(entry);
  });

  it("counts pending ones and flags new failures and misses in warning color", () => {
    const { rerender } = render(
      <RoomSidebar {...props({ scheduleCounts: { pending: 4, attention: 0 } })} />,
    );
    const pending = screen.getByRole("button", { name: "定时任务，4 个待执行" });
    const badges = () => [...pending.querySelectorAll(".sidebar-badge")];
    expect(badges().map((badge) => [badge.className, badge.textContent])).toEqual([
      ["sidebar-badge", "4"],
    ]);

    rerender(<RoomSidebar {...props({ scheduleCounts: { pending: 120, attention: 2 } })} />);
    const flagged = screen.getByRole("button", {
      name: "定时任务，120 个待执行，2 个没有正常完成",
    });
    expect(
      [...flagged.querySelectorAll(".sidebar-badge")].map((badge) => [
        badge.className,
        badge.textContent,
      ]),
    ).toEqual([
      ["sidebar-badge", "99+"],
      ["sidebar-badge warning", "2"],
    ]);
  });
});

describe("sidebar user menu", () => {
  it("offers 「在其他设备登录」 only when the page can manage owner devices", () => {
    const openOwnerDevices = vi.fn();
    const setUserMenuOpen = vi.fn();
    const { rerender } = render(<RoomSidebar {...props({ userMenuOpen: true })} />);
    expect(screen.getByRole("menuitem", { name: "设置" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "在其他设备登录" })).toBeNull();

    rerender(<RoomSidebar {...props({ userMenuOpen: true, openOwnerDevices, setUserMenuOpen })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "在其他设备登录" }));
    expect(openOwnerDevices).toHaveBeenCalled();
    expect(setUserMenuOpen).toHaveBeenCalledWith(false);
  });

  it("links 「帮助与文档」 to the docs site in a new tab, in the interface language", () => {
    const setUserMenuOpen = vi.fn();
    const { rerender } = render(
      <RoomSidebar {...props({ userMenuOpen: true, setUserMenuOpen })} />,
    );
    const docs = screen.getByRole("menuitem", { name: /帮助与文档/ });
    expect(docs.getAttribute("href")).toBe(DOCS_BASE_URL);
    expect(docs.getAttribute("target")).toBe("_blank");
    fireEvent.click(docs);
    expect(setUserMenuOpen).toHaveBeenCalledWith(false);

    setLocalePreference("en");
    try {
      rerender(<RoomSidebar {...props({ userMenuOpen: true })} />);
      expect(screen.getByRole("menuitem", { name: /Help & docs/ }).getAttribute("href")).toBe(
        `${DOCS_BASE_URL}en/`,
      );
    } finally {
      setLocalePreference("zh-CN");
    }
  });

  it("links 「下载客户端」 to the latest GitHub release in the browser, but not in the desktop app", () => {
    const setUserMenuOpen = vi.fn();
    const setMobilePanel = vi.fn();
    const { rerender } = render(
      <RoomSidebar {...props({ userMenuOpen: true, setUserMenuOpen, setMobilePanel })} />,
    );
    const download = screen.getByRole("menuitem", { name: /下载客户端/ });
    expect(DESKTOP_DOWNLOAD_URL).toBe("https://github.com/wangrongding/SuperHive/releases/latest");
    expect(download.getAttribute("href")).toBe(DESKTOP_DOWNLOAD_URL);
    expect(download.getAttribute("target")).toBe("_blank");
    expect(download.getAttribute("rel")).toBe("noreferrer");
    fireEvent.click(download);
    expect(setUserMenuOpen).toHaveBeenCalledWith(false);
    expect(setMobilePanel).toHaveBeenCalledWith(undefined);

    const noop = () => () => {};
    window.superhiveDesktop = {
      version: 1,
      platform: "darwin",
      terminal: Object.fromEntries(
        ["create", "write", "resize", "kill", "onData", "onExit", "onNewRequest"].map((name) => [
          name,
          noop,
        ]),
      ),
    };
    try {
      rerender(<RoomSidebar {...props({ userMenuOpen: true })} />);
      expect(screen.getByRole("menuitem", { name: /帮助与文档/ })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /下载客户端/ })).toBeNull();
    } finally {
      delete window.superhiveDesktop;
    }
  });
});

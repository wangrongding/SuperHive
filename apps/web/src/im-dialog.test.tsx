// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImConnection } from "@superhive/protocol";
import { ImDialog } from "./im-dialog";
import { getLocalePreference, setLocalePreference } from "./i18n";

type Route = { method: string; url: string; body?: unknown };

function mockServer(handler: (route: Route) => unknown) {
  const calls: Route[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = {
        method: init.method ?? "GET",
        url: url.replace("http://hive", ""),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      calls.push(route);
      return new Response(JSON.stringify(handler(route)), { status: 200 });
    }),
  );
  return calls;
}

const feishu: ImConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "autoclaw-web",
  roomName: "autoclaw-web",
  channel: "feishu",
  ownerName: "rd",
  label: "Autoclaw助手",
  status: "connected",
  level: "mine",
  locale: "zh-CN",
  scope: "all",
  delivery: {
    lastAt: "2026-11-12T10:00:00.000Z",
    lastStatus: "sent",
    lastSentAt: "2026-11-12T10:00:00.000Z",
    pending: 0,
    filtered: 3,
  },
  createdAt: "2026-11-10T00:00:00.000Z",
  lastInboundAt: "2026-11-12T09:00:00.000Z",
};

const wechat: ImConnection = {
  id: "22222222-2222-4222-8222-222222222222",
  roomId: "build",
  roomName: "build",
  channel: "wechat",
  ownerName: "rd",
  label: "个人微信",
  status: "connected",
  level: "all",
  locale: "zh-CN",
  scope: "all",
  attention: "needs_message",
  heldSince: "2026-11-12T10:50:00.000Z",
  delivery: { pending: 5, filtered: 0 },
  createdAt: "2026-11-12T08:00:00.000Z",
};

function renderDialog(rooms = [{ id: "build", name: "build" }]) {
  return render(
    <ImDialog
      base="http://hive"
      adminToken="t"
      roomId="build"
      ownerName="rd"
      rooms={rooms}
      onClose={() => undefined}
    />,
  );
}

describe("我的 IM 连接", () => {
  const original = getLocalePreference();
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocalePreference(original);
  });

  it("不管从哪个房间打开都列出全部连接：状态一眼看清，有问题写明原因和怎么办", async () => {
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/im/connections") return { connections: [feishu, wechat] };
      return {};
    });
    renderDialog();
    const cards = await screen.findAllByRole("listitem");
    expect(cards).toHaveLength(2);
    // 列的是房主全部连接，不是当前房间的
    expect(calls.some((call) => call.url === "/api/im/connections")).toBe(true);
    expect(calls.some((call) => call.url === "/api/rooms/build/im")).toBe(false);

    const [first, second] = cards as [HTMLElement, HTMLElement];
    expect(within(first).getByText("Autoclaw助手")).toBeTruthy();
    expect(within(first).getByText("正常")).toBeTruthy();
    expect(within(first).getByText("# autoclaw-web")).toBeTruthy();
    expect(within(first).queryByRole("status")).toBeNull();

    expect(within(second).getByText("推送暂停")).toBeTruthy();
    const problem = within(second).getByRole("status");
    expect(problem.textContent).toContain("要你在微信里给机器人发一条消息");
    expect(problem.textContent).toContain("在微信里给「个人微信」随便发一句");
    expect(within(second).getByText(/待发 5 条/)).toBeTruthy();
  });

  it("卡片上四项直接是下拉：显示当前值，选了就改默认房间、接收范围、推送档位、语言", async () => {
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: false } };
      if (route.url === "/api/im/connections") return { connections: [feishu] };
      return feishu;
    });
    renderDialog([
      { id: "build", name: "build" },
      { id: "autoclaw-web", name: "autoclaw-web" },
    ]);
    const room = await screen.findByRole("combobox", { name: "默认房间" });
    // 不用展开：当前值直接显示在下拉上
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    expect(room.textContent).toContain("# autoclaw-web");
    const pick = async (combobox: string, option: RegExp) => {
      fireEvent.click(screen.getByRole("combobox", { name: combobox }));
      fireEvent.click(await screen.findByRole("option", { name: option }));
    };
    await pick("默认房间", /^# build/);
    await pick("推送档位", /^全部 Agent/);
    await pick("接收哪些房间", /^仅默认房间/);
    await pick("机器人语言", /^English/);
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
        { roomId: "build" },
        { level: "agents" },
        { scope: "current" },
        { locale: "en" },
      ]),
    );
    expect(calls.find((call) => call.body && "roomId" in (call.body as object))?.url).toBe(
      `/api/im/connections/${feishu.id}/room`,
    );
  });

  it.each(["zh-CN", "en"] as const)(
    "%s：跨房间全部推送默认关闭，开关保存且说明过滤范围和摘要频率",
    async (locale) => {
      setLocalePreference(locale);
      let connection: ImConnection = { ...feishu, level: "all" };
      const calls = mockServer((route) => {
        if (route.url === "/api/im/channels")
          return { feishu: { enabled: true }, wechat: { enabled: false } };
        if (route.url === "/api/im/connections") return { connections: [connection] };
        if (route.url.endsWith("/cross-room-all"))
          connection = { ...connection, ...(route.body as { crossRoomAll: boolean }) };
        return connection;
      });
      renderDialog();
      const label = locale === "en" ? "Include all messages from other rooms" : "其它房间也推全部";
      const toggle = await screen.findByRole("switch", { name: new RegExp(label) });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(
        screen.getByText(
          locale === "en"
            ? /All levels exclude scheduled trigger notes/
            : /所有档位均不推定时触发备忘/,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(locale === "en" ? /around 20 per hour/ : /约 20 张\/小时/),
      ).toBeTruthy();
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(
          screen.getByRole("switch", { name: new RegExp(label) }).getAttribute("aria-checked"),
        ).toBe("true"),
      );
      expect(calls.find((route) => route.method === "POST")).toMatchObject({
        url: `/api/im/connections/${feishu.id}/cross-room-all`,
        body: { crossRoomAll: true },
      });
      fireEvent.click(screen.getByRole("switch", { name: new RegExp(label) }));
      await waitFor(() => expect(connection.crossRoomAll).toBe(false));
    },
  );

  it.each([
    { level: "mine", scope: "all" },
    { level: "all", scope: "current" },
  ] as const)("跨房间开关仅在 all 档且接收所有房间时出现：%o", async (setting) => {
    mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: false } };
      if (route.url === "/api/im/connections") return { connections: [{ ...feishu, ...setting }] };
      return feishu;
    });
    renderDialog();
    await screen.findByText("Autoclaw助手");
    expect(screen.queryByRole("switch", { name: /其它房间也推全部/ })).toBeNull();
  });

  it("还没有连接时显示引导；新增连接单独一步：个人微信先确认风险再扫码", async () => {
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/im/connections") return { connections: [] };
      if (route.url.endsWith("/im/login"))
        return {
          id: "33333333-3333-4333-8333-333333333333",
          channel: "wechat",
          roomId: "build",
          status: "waiting_scan",
          qrDataUrl: "data:image/png;base64,AAAA",
        };
      return {};
    });
    renderDialog();
    expect(await screen.findByText("还没有连接 IM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接个人微信" }));
    expect(screen.getByRole("heading", { name: "新增 IM 连接" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /个人微信/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const start = screen.getByRole("button", { name: "扫码连接个人微信" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    expect(await screen.findByAltText("个人微信扫码二维码")).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/im/login"))?.body).toEqual({
      channel: "wechat",
      ownerName: "rd",
      // 机器人先说网页当前的语言
      locale: "zh-CN",
      acceptRisk: true,
    });
    // 返回列表时放弃扫码
    fireEvent.click(screen.getByRole("button", { name: "返回连接列表" }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.method === "DELETE" && call.url.includes("/im/logins/")),
      ).toBe(true),
    );
  });

  it("从状态栏角标点进来：滚到要处理的那张卡片并标出来", async () => {
    mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/im/connections") return { connections: [feishu, wechat] };
      return {};
    });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <ImDialog
        base="http://hive"
        adminToken="t"
        roomId="build"
        ownerName="rd"
        focusId={wechat.id}
        onClose={() => undefined}
      />,
    );
    const cards = await screen.findAllByRole("listitem");
    const target = cards.find((card) => card.getAttribute("data-id") === wechat.id)!;
    await waitFor(() => expect(target.className).toContain("focused"));
    expect(cards.find((card) => card !== target)!.className).not.toContain("focused");
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("关闭个人微信时新增连接只有飞书", async () => {
    mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: false } };
      if (route.url === "/api/im/connections") return { connections: [feishu] };
      return {};
    });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
    expect(screen.getByRole("radio", { name: /飞书/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /个人微信/ })).toBeNull();
  });

  it("英文界面：状态、原因和服务端的结构化文案都按网页语言显示", async () => {
    setLocalePreference("en");
    const expired: ImConnection = {
      ...wechat,
      attention: "relogin",
      status: "error",
      detail: "微信登录已过期，请重新扫码连接。",
      detailText: { key: "error.im.wechatExpired" },
    };
    mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/im/connections") return { connections: [expired, feishu] };
      return {};
    });
    renderDialog();
    const [card] = (await screen.findAllByRole("listitem")) as [HTMLElement];
    expect(within(card).getByText("Scan again", { selector: ".im-health" })).toBeTruthy();
    expect(within(card).getByRole("status").textContent).toContain(
      "Your WeChat sign-in expired. Scan the QR code again to reconnect.",
    );
    expect(screen.queryByText(/微信登录已过期/)).toBeNull();
    // 「重新扫码」直接进新增连接，渠道选好
    fireEvent.click(within(card).getByRole("button", { name: "Scan again" }));
    expect(
      screen.getByRole("radio", { name: /Personal WeChat|WeChat/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

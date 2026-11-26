import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ImChannel, ImChannelsInfo, ImConnection, ImLoginView } from "@superhive/protocol";
import {
  IM_CHANNEL_LABELS,
  IM_LEVELS,
  cancelImLogin,
  fetchImChannels,
  getImLogin,
  listAllImConnections,
  removeImConnection,
  serverMessage,
  setImConnectionPaused,
  setImDeliveryLevel,
  setImLocale,
  setImRoom,
  setImScope,
  setImCrossRoomAll,
  startImLogin,
  submitImLoginCode,
} from "./im-api";
import { LOCALE_OPTIONS, getLocale, localized, t } from "./i18n";
import { Select } from "./select";
import { DocsLink } from "./docs-link";
import { Button, IconButton } from "./button";
import { SettingsSwitch } from "./settings-switch";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M15 6 9 12l6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 渠道图标：飞书蓝、微信绿的圆角方块里一个字，不依赖外部图片 */
function ChannelMark({ channel }: { channel: ImChannel }) {
  return (
    <span className={`im-channel-mark ${channel}`} aria-hidden="true">
      {channel === "feishu" ? (
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M5 7.5c3.2.4 6.1 2.1 8.3 4.6l1.4 1.6c1.2 1.3 3 1.8 4.6 1.2-1.4 2.6-4.6 3.8-7.4 2.6L5 14.4z"
            fill="currentColor"
          />
          <path d="M9 5h7.2c.9 1 1.5 2.2 1.8 3.5L14.5 10C13 8 11.1 6.3 9 5z" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M9.5 5C5.9 5 3 7.4 3 10.4c0 1.7.9 3.2 2.4 4.2L4.8 16.5l2.3-1.2c.7.2 1.5.3 2.3.3h.4a4.7 4.7 0 0 1-.2-1.3c0-3 2.9-5.4 6.4-5.4h.3C15.7 6.6 12.9 5 9.5 5z"
            fill="currentColor"
          />
          <path
            d="M21 14.3c0-2.4-2.4-4.4-5.2-4.4s-5.2 2-5.2 4.4 2.4 4.4 5.2 4.4c.6 0 1.2-.1 1.7-.2l1.9 1-.5-1.6c1.3-.8 2.1-2.1 2.1-3.6z"
            fill="currentColor"
          />
        </svg>
      )}
    </span>
  );
}

const loginHints: Partial<Record<ImLoginView["status"], string>> = localized(() => ({
  starting: t("正在获取二维码…"),
  waiting_scan: "",
  scanned: t("已扫码，请在手机上确认"),
  need_code: t("请输入手机上显示的配对码"),
  connecting: t("正在连接…"),
}));

const channelIntros: Record<ImChannel, string> = localized(() => ({
  feishu: t("官方开放平台，支持卡片、按钮、图片和文件；适合长期使用"),
  wechat: t("经腾讯 iLink 通道，只有文字，有封号风险；默认不启用"),
}));

const scanGuides: Record<ImChannel, string> = localized(() => ({
  feishu: t(
    "用飞书扫码，按页面提示新建或选择一个应用并确认权限。扫码的人就是房主身份：之后私聊这个机器人，消息会以你的名义发进房间。",
  ),
  wechat: t("用微信扫码并在手机上确认登录。之后在微信里给这个账号发消息，会以你的名义发进房间。"),
}));

function shortTime(value: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(getLocale(), {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Health = {
  tone: "ok" | "info" | "warning" | "danger" | "muted";
  label: string;
  /** 有问题时：出了什么事、怎么解决 */
  problem?: { title: string; fix: string; since?: string };
};

/** 一个连接现在好不好用；有问题时写清原因和怎么办 */
export function connectionHealth(connection: ImConnection): Health {
  if (connection.status === "paused") return { tone: "muted", label: t("已暂停") };
  if (connection.attention === "relogin") {
    return {
      tone: "danger",
      label: t("需要重新扫码"),
      problem: {
        title: serverMessage(connection.detailText, connection.detail ?? t("登录已失效")),
        fix: t("点「重新扫码」再连一次。推送档位、语言这些设置会保留。"),
      },
    };
  }
  if (connection.attention === "needs_message") {
    return {
      tone: "warning",
      label: t("推送暂停"),
      problem: {
        title: t("要你在微信里给机器人发一条消息"),
        fix: t(
          "个人微信只能在你给机器人发过消息之后推送，隔一阵或推了几条就得再发一次。在微信里给「{0}」随便发一句，暂停期间的推送会合成一条补发过来。",
          { 0: connection.label },
        ),
        ...(connection.heldSince ? { since: connection.heldSince } : {}),
      },
    };
  }
  if (connection.status === "error") {
    return {
      tone: "danger",
      label: t("连接异常"),
      problem: {
        title: serverMessage(connection.detailText, connection.detail ?? t("原因未知")),
        fix: t("点「重新连接」再试一次；一直不行就重新扫码。"),
      },
    };
  }
  if (connection.status === "connecting") return { tone: "info", label: t("连接中") };
  if (connection.attention === "push_failing") {
    return {
      tone: "warning",
      label: t("推送失败"),
      problem: {
        title: connection.delivery.lastError ?? t("原因未知"),
        fix: t("会自动重试。一直失败的话，检查机器人的权限，或重新扫码。"),
      },
    };
  }
  return { tone: "ok", label: t("正常") };
}

const LOGIN_DONE: ImLoginView["status"][] = ["succeeded", "failed", "cancelled"];

type RoomOption = { id: string; name: string };

/**
 * 我的 IM 连接：飞书机器人、个人微信。连接不属于某个房间——房间只是「直接发的消息进哪」，
 * 推送按接收范围来；所以不管从哪个房间打开，都列出房主的全部连接。
 */
export function ImDialog({
  base,
  adminToken,
  roomId,
  ownerName,
  rooms = [],
  onClose,
}: {
  base: string;
  adminToken: string;
  roomId: string;
  ownerName: string;
  /** 可选的默认房间（房主所在、没归档的） */
  rooms?: RoomOption[];
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<ImChannelsInfo>();
  const [connections, setConnections] = useState<ImConnection[]>();
  const [view, setView] = useState<"list" | "add">("list");
  const [channel, setChannel] = useState<ImChannel>("feishu");
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [login, setLogin] = useState<ImLoginView>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const loginRef = useRef<ImLoginView | undefined>(undefined);
  loginRef.current = login;

  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  const refresh = useCallback(
    () => listAllImConnections(base, adminToken).then(setConnections, fail),
    [adminToken, base],
  );

  useEffect(() => {
    void fetchImChannels(base, adminToken).then(setChannels, fail);
    void refresh();
  }, [adminToken, base, refresh]);

  // 扫码进行中每秒查一次进度；连接状态每 3 秒刷新
  useEffect(() => {
    const active = login && !LOGIN_DONE.includes(login.status);
    const timer = window.setInterval(
      () => {
        const current = loginRef.current;
        if (current && !LOGIN_DONE.includes(current.status)) {
          void getImLogin(base, adminToken, current.id).then((next) => {
            setLogin(next);
            if (next.status === "succeeded") void refresh();
          }, fail);
        } else {
          void refresh();
        }
      },
      active ? 1_000 : 3_000,
    );
    return () => window.clearInterval(timer);
  }, [adminToken, base, login, refresh]);

  // onClose 每次渲染都是新函数：用 ref 取最新的，监听只挂一次，按键分发途中重渲染也不会把它换掉
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 关闭弹窗时放弃还没完成的扫码
  useEffect(
    () => () => {
      const current = loginRef.current;
      if (current && !LOGIN_DONE.includes(current.status)) {
        void cancelImLogin(base, adminToken, current.id).catch(() => undefined);
      }
    },
    [adminToken, base],
  );

  const scanning = Boolean(login && !LOGIN_DONE.includes(login.status));
  const wechatEnabled = channels?.wechat.enabled ?? false;

  function openAdd(next: ImChannel = channel) {
    setError(undefined);
    setChannel(next);
    setLogin(undefined);
    setCode("");
    setView("add");
  }

  async function backToList() {
    if (login && scanning) await cancelImLogin(base, adminToken, login.id).catch(() => undefined);
    setLogin(undefined);
    setError(undefined);
    setView("list");
    void refresh();
  }

  async function begin() {
    setError(undefined);
    setCode("");
    try {
      const started = await startImLogin(base, adminToken, roomId, {
        channel,
        ownerName,
        // 机器人先说和网页一样的语言，之后可以在这里或 IM 里用 /lang 改
        locale: getLocale(),
        ...(channel === "wechat" ? { acceptRisk } : {}),
      });
      setLogin(started);
    } catch (reason) {
      fail(reason);
    }
  }

  const update = (action: Promise<unknown>) => void action.then(refresh, fail);

  const list = connections ?? [];
  const title = view === "add" ? t("新增 IM 连接") : t("IM 连接");

  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="invite-dialog im-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="im-dialog-title"
      >
        <header className="invite-dialog-header im-dialog-header">
          <div className="im-dialog-heading">
            {view === "add" && (
              <IconButton
                className="im-back"
                variant="secondary"
                label={t("返回连接列表")}
                onClick={() => void backToList()}
              >
                <BackGlyph />
              </IconButton>
            )}
            <div>
              <h2 id="im-dialog-title">{title}</h2>
              <p>
                {view === "add"
                  ? t("扫码一次就好。之后在 IM 里发的消息以 {0} 的身份进房间。", { 0: ownerName })
                  : t(
                      "在飞书、微信里给房间发消息、收推送。这里是你的全部连接，和从哪个房间打开无关。",
                    )}{" "}
                <DocsLink to="im">{t("飞书和微信指南")}</DocsLink>
              </p>
            </div>
          </div>
          <div className="im-dialog-tools">
            {view === "list" && list.length > 0 && (
              <Button variant="primary" onClick={() => openAdd()}>
                {t("新增连接")}
              </Button>
            )}
            <IconButton label={t("关闭")} onClick={onClose}>
              <CloseGlyph />
            </IconButton>
          </div>
        </header>

        <div className="invite-dialog-body im-dialog-body">
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}

          {view === "list" ? (
            connections === undefined ? (
              <p className="im-loading">{t("正在加载…")}</p>
            ) : list.length === 0 ? (
              <EmptyState wechatEnabled={wechatEnabled} onAdd={openAdd} />
            ) : (
              <ul className="im-cards" aria-label={t("我的 IM 连接")}>
                {list.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    rooms={rooms}
                    onPause={(paused) =>
                      update(setImConnectionPaused(base, adminToken, connection.id, paused))
                    }
                    onRescan={() => openAdd(connection.channel)}
                    onRemove={() => {
                      if (
                        window.confirm(
                          t(
                            "断开后，这个 IM 发来的消息不再进入房间，保存的凭据也会删除。确定断开？",
                          ),
                        )
                      ) {
                        update(removeImConnection(base, adminToken, connection.id));
                      }
                    }}
                    onLevel={(level) =>
                      update(setImDeliveryLevel(base, adminToken, connection.id, level))
                    }
                    onLocale={(locale) =>
                      update(setImLocale(base, adminToken, connection.id, locale))
                    }
                    onScope={(scope) => update(setImScope(base, adminToken, connection.id, scope))}
                    onCrossRoomAll={(enabled) =>
                      update(setImCrossRoomAll(base, adminToken, connection.id, enabled))
                    }
                    onRoom={(room) => update(setImRoom(base, adminToken, connection.id, room))}
                  />
                ))}
              </ul>
            )
          ) : (
            <AddConnection
              channel={channel}
              wechatEnabled={wechatEnabled}
              acceptRisk={acceptRisk}
              login={login}
              scanning={scanning}
              code={code}
              onChannel={(next) => {
                setChannel(next);
                setLogin(undefined);
              }}
              onAcceptRisk={setAcceptRisk}
              onCode={setCode}
              onBegin={() => void begin()}
              onCancel={() =>
                login && void cancelImLogin(base, adminToken, login.id).then(setLogin, fail)
              }
              onSubmitCode={() =>
                login &&
                void submitImLoginCode(base, adminToken, login.id, code).then(setLogin, fail)
              }
              onDone={() => void backToList()}
              onBack={() => void backToList()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  wechatEnabled,
  onAdd,
}: {
  wechatEnabled: boolean;
  onAdd: (channel: ImChannel) => void;
}) {
  return (
    <div className="im-empty">
      <div className="im-empty-marks" aria-hidden="true">
        <ChannelMark channel="feishu" />
        <ChannelMark channel="wechat" />
      </div>
      <strong>{t("还没有连接 IM")}</strong>
      <p>
        {t(
          "连上之后，不开网页也能在手机上派活、回答 Agent 的提问；你所在的所有房间里和你有关的结果都会推过来。",
        )}
      </p>
      <div className="dialog-actions center im-empty-actions">
        {wechatEnabled && <Button onClick={() => onAdd("wechat")}>{t("连接个人微信")}</Button>}
        <Button variant="primary" onClick={() => onAdd("feishu")}>
          {t("连接飞书")}
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="im-fact">
      <span className="im-fact-label" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

function ConnectionCard({
  connection,
  rooms,
  onPause,
  onRescan,
  onRemove,
  onLevel,
  onLocale,
  onScope,
  onCrossRoomAll,
  onRoom,
}: {
  connection: ImConnection;
  rooms: RoomOption[];
  onPause: (paused: boolean) => void;
  onRescan: () => void;
  onRemove: () => void;
  onLevel: (level: ImConnection["level"]) => void;
  onLocale: (locale: NonNullable<ImConnection["locale"]>) => void;
  onScope: (scope: NonNullable<ImConnection["scope"]>) => void;
  onCrossRoomAll: (enabled: boolean) => void;
  onRoom: (roomId: string) => void;
}) {
  const health = connectionHealth(connection);
  const scope = connection.scope ?? "all";
  const locale = connection.locale ?? "zh-CN";
  const roomName = connection.roomName ?? connection.roomId;
  // 默认房间的候选：当前这个一定在里面
  const roomOptions = rooms.some((room) => room.id === connection.roomId)
    ? rooms
    : [{ id: connection.roomId, name: roomName }, ...rooms];
  return (
    <li className={`im-card ${health.tone}`}>
      <div className="im-card-head">
        <ChannelMark channel={connection.channel} />
        <div className="im-card-title">
          <strong>{connection.label}</strong>
          {/* 个人微信的名称就是「个人微信」，不再重复一遍渠道 */}
          {connection.label !== IM_CHANNEL_LABELS[connection.channel] && (
            <small>{IM_CHANNEL_LABELS[connection.channel]}</small>
          )}
        </div>
        <span className={`im-health ${health.tone}`}>
          <span className="im-health-dot" aria-hidden="true" />
          {health.label}
        </span>
        {/* 常用操作放在标题栏右侧，不再单独占一行 */}
        <div className="im-card-actions">
          {/* 要你处理的那一步用主要按钮，其余是描边小按钮；断开放最后、红字 */}
          {connection.attention === "relogin" && (
            <Button variant="primary" size="sm" onClick={onRescan}>
              {t("重新扫码")}
            </Button>
          )}
          {connection.status === "error" && connection.attention !== "relogin" && (
            <Button variant="primary" size="sm" onClick={() => onPause(false)}>
              {t("重新连接")}
            </Button>
          )}
          <Button size="sm" onClick={() => onPause(connection.status !== "paused")}>
            {connection.status === "paused" ? t("继续") : t("暂停")}
          </Button>
          <Button size="sm" tone="danger" onClick={onRemove}>
            {t("断开")}
          </Button>
        </div>
      </div>

      {/* 四项设置直接做成下拉：一眼看到当前值，点开就能改，不用再展开「设置」 */}
      <div className="im-card-facts">
        <Fact label={t("默认房间")}>
          <Select
            className="im-fact-select"
            aria-label={t("默认房间")}
            value={connection.roomId}
            options={roomOptions.map((room) => ({
              value: room.id,
              label: `# ${room.name}`,
            }))}
            onChange={(next) => {
              if (next !== connection.roomId) onRoom(next);
            }}
          />
        </Fact>
        <Fact label={t("接收")}>
          <Select
            className="im-fact-select"
            aria-label={t("接收哪些房间")}
            value={scope}
            options={[
              {
                value: "all",
                label: t("所有房间"),
                description: t(
                  "你所在的所有房间都会推过来，其他房间的卡片标成橙色；直接回复卡片会发到那个房间",
                ),
              },
              { value: "current", label: t("仅默认房间"), description: t("只推默认房间的消息") },
            ]}
            onChange={(next) => {
              if (next !== scope) onScope(next);
            }}
          />
        </Fact>
        <Fact label={t("推送")}>
          <Select
            className="im-fact-select"
            aria-label={t("推送档位")}
            value={connection.level}
            options={IM_LEVELS.map((item) => ({
              value: item.level,
              label: item.label,
              description: item.hint,
            }))}
            onChange={(next) => {
              if (next !== connection.level) onLevel(next);
            }}
          />
        </Fact>
        <Fact label={t("语言")}>
          <Select
            className="im-fact-select"
            aria-label={t("机器人语言")}
            value={locale}
            options={LOCALE_OPTIONS.flatMap((option) =>
              option.value === "system"
                ? []
                : [
                    {
                      value: option.value,
                      label: option.label,
                      description: t("卡片、按钮和提示用这个语言；在 IM 里发 /lang 也能切换"),
                    },
                  ],
            )}
            onChange={(next) => {
              if (next !== locale) onLocale(next);
            }}
          />
        </Fact>
      </div>

      <div className="im-card-policy">
        <p>{IM_LEVELS.find((item) => item.level === connection.level)?.hint}</p>
        <p>
          {t(
            "所有档位均不推定时触发备忘、你自己的消息回显、Agent 内部派活和回执（提到你除外）、非你任务的进度。提到你、问你和需要处理的通知立即推送。",
          )}
        </p>
        {(connection.level === "all" || connection.level === "agents") && (
          <p>
            {t(
              "普通消息每个活跃房间约每 3 分钟一张摘要；约 20 张/小时，长消息可能拆分，紧急通知和附件另计。",
            )}
          </p>
        )}
        {connection.level === "all" && scope === "all" && (
          <SettingsSwitch
            checked={connection.crossRoomAll ?? false}
            label={t("其它房间也推全部")}
            description={t(
              "默认关闭：其它房间只推与你相关的；开启后其它房间的普通消息也按 3 分钟合并，仍过滤噪音。",
            )}
            onChange={onCrossRoomAll}
          />
        )}
      </div>

      <p className="im-card-activity">
        {[
          connection.lastInboundAt
            ? t("最近收到 {0}", { 0: shortTime(connection.lastInboundAt) })
            : t("还没收到过你的消息"),
          connection.delivery.lastSentAt
            ? t("最近推送成功 {0}", { 0: shortTime(connection.delivery.lastSentAt) })
            : t("还没推送成功过"),
          ...(connection.delivery.pending
            ? [t("待发 {0} 条", { 0: connection.delivery.pending })]
            : []),
        ].join(" · ")}
      </p>

      {health.problem && (
        <div className={`im-problem ${health.tone}`} role="status">
          <strong>
            {health.problem.title}
            {health.problem.since && (
              <span>{t("（{0} 起）", { 0: shortTime(health.problem.since) })}</span>
            )}
          </strong>
          <p>{health.problem.fix}</p>
        </div>
      )}
    </li>
  );
}

function AddConnection({
  channel,
  wechatEnabled,
  acceptRisk,
  login,
  scanning,
  code,
  onChannel,
  onAcceptRisk,
  onCode,
  onBegin,
  onCancel,
  onSubmitCode,
  onDone,
  onBack,
}: {
  channel: ImChannel;
  wechatEnabled: boolean;
  acceptRisk: boolean;
  login: ImLoginView | undefined;
  scanning: boolean;
  code: string;
  onChannel: (channel: ImChannel) => void;
  onAcceptRisk: (value: boolean) => void;
  onCode: (value: string) => void;
  onBegin: () => void;
  onCancel: () => void;
  onSubmitCode: () => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const channels = (["feishu", "wechat"] as const).filter(
    (item) => item === "feishu" || wechatEnabled,
  );
  if (login?.status === "succeeded") {
    return (
      <div className="im-added" role="status">
        <ChannelMark channel={login.channel} />
        <strong>{t("{0}已连接", { 0: IM_CHANNEL_LABELS[login.channel] })}</strong>
        <p>
          {login.channel === "wechat"
            ? t("先在微信里给机器人发一条消息（比如 /help），之后才收得到推送。")
            : t("在飞书里私聊机器人发 /help 看看能做什么。")}
        </p>
        <div className="dialog-actions center">
          <Button variant="primary" onClick={onDone}>
            {t("完成")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="im-add-flow">
      <div className="im-channel-picker" role="radiogroup" aria-label={t("渠道")}>
        {channels.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={channel === item}
            className={channel === item ? "on" : ""}
            disabled={scanning}
            onClick={() => onChannel(item)}
          >
            <ChannelMark channel={item} />
            <span>
              <strong>{IM_CHANNEL_LABELS[item]}</strong>
              <small>{channelIntros[item]}</small>
            </span>
          </button>
        ))}
      </div>

      <p className="im-guide">{scanGuides[channel]}</p>

      {channel === "wechat" && (
        <div className="im-risk" role="note">
          <strong>{t("个人微信有风险，默认不启用")}</strong>
          <p>
            {t(
              "个人微信没有面向第三方的公开开放平台，这里经腾讯 iLink 通道接入，可能违反平台规则，有被限制或封号的风险； 消息内容会经过微信服务器。只支持你本人在私聊里发的文字。",
            )}
          </p>
          <label>
            <input
              type="checkbox"
              checked={acceptRisk}
              disabled={scanning}
              onChange={(event) => onAcceptRisk(event.target.checked)}
            />
            {t("我了解风险，仍要连接")}
          </label>
        </div>
      )}

      {login && (scanning || login.status === "failed") && (
        <div className="im-login" role="status">
          {login.qrDataUrl && scanning ? (
            <img
              className="im-qr"
              src={login.qrDataUrl}
              alt={t("{0}扫码二维码", { 0: IM_CHANNEL_LABELS[login.channel] })}
            />
          ) : null}
          <div className="im-login-copy">
            {login.status === "failed" ? (
              <strong className="im-failed">
                {t("连接失败：{0}", { 0: serverMessage(login.errorText, login.error ?? "") })}
              </strong>
            ) : (
              <>
                <strong>
                  {login.status === "waiting_scan"
                    ? t("请用{0}扫描二维码", { 0: IM_CHANNEL_LABELS[login.channel] })
                    : loginHints[login.status]}
                </strong>
                {login.qrUrl && login.channel === "feishu" && (
                  <small>
                    {t("也可以在手机上直接打开")}
                    <a href={login.qrUrl} target="_blank" rel="noreferrer">
                      {t("这个链接")}
                    </a>
                  </small>
                )}
                {login.error && (
                  <small className="im-failed">{serverMessage(login.errorText, login.error)}</small>
                )}
              </>
            )}
            {login.status === "need_code" && (
              <form
                className="im-code"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmitCode();
                }}
              >
                <input
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  maxLength={8}
                  aria-label={t("配对码")}
                  onChange={(event) => onCode(event.target.value.replace(/\D/g, ""))}
                />
                <Button type="submit" variant="primary" disabled={code.length < 4}>
                  {t("提交")}
                </Button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* 底部操作区：主要按钮在最右；扫码进行中只剩「取消扫码」 */}
      <div className="dialog-actions">
        {scanning ? (
          <Button onClick={onCancel}>{t("取消扫码")}</Button>
        ) : (
          <>
            <Button onClick={onBack}>{t("返回")}</Button>
            <Button
              variant="primary"
              disabled={channel === "wechat" && !acceptRisk}
              onClick={onBegin}
            >
              {login?.status === "failed"
                ? t("重新扫码")
                : t("扫码连接{0}", { 0: IM_CHANNEL_LABELS[channel] })}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

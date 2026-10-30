import { useCallback, useEffect, useRef, useState } from "react";
import type { ImChannel, ImChannelsInfo, ImConnection, ImLoginView } from "@ai-hive/protocol";
import {
  IM_CHANNEL_LABELS,
  cancelImLogin,
  fetchImChannels,
  getImLogin,
  listImConnections,
  removeImConnection,
  setImConnectionPaused,
  startImLogin,
  submitImLoginCode,
} from "./im-api";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const statusLabels: Record<ImConnection["status"], string> = {
  connecting: "连接中",
  connected: "已连接",
  paused: "已暂停",
  error: "连接异常",
};

const loginHints: Partial<Record<ImLoginView["status"], string>> = {
  starting: "正在获取二维码…",
  waiting_scan: "",
  scanned: "已扫码，请在手机上确认",
  need_code: "请输入手机上显示的配对码",
  connecting: "正在连接…",
};

const scanGuides: Record<ImChannel, string> = {
  feishu:
    "用飞书扫码，按页面提示新建或选择一个应用并确认权限。扫码的人就是房主身份：之后私聊这个机器人，消息会以你的名义发进房间。",
  wechat: "用微信扫码并在手机上确认登录。之后在微信里给这个账号发消息，会以你的名义发进房间。",
};

const LOGIN_DONE: ImLoginView["status"][] = ["succeeded", "failed", "cancelled"];

/**
 * 房主把飞书机器人或个人微信接进当前房间：扫码一次即可。
 * IM 里发的消息以房主本人身份进房间；由此发起的任务结果、@ 房主的消息和提问再推回原会话。
 */
export function ImDialog({
  base,
  adminToken,
  roomId,
  ownerName,
  onClose,
}: {
  base: string;
  adminToken: string;
  roomId: string;
  ownerName: string;
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<ImChannelsInfo>();
  const [channel, setChannel] = useState<ImChannel>("feishu");
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [connections, setConnections] = useState<ImConnection[]>([]);
  const [login, setLogin] = useState<ImLoginView>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const loginRef = useRef<ImLoginView | undefined>(undefined);
  loginRef.current = login;

  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  const refresh = useCallback(
    () => listImConnections(base, adminToken, roomId).then(setConnections, fail),
    [adminToken, base, roomId],
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
          void getImLogin(base, adminToken, current.id).then((view) => {
            setLogin(view);
            if (view.status === "succeeded") void refresh();
          }, fail);
        } else {
          void refresh();
        }
      },
      active ? 1_000 : 3_000,
    );
    return () => window.clearInterval(timer);
  }, [adminToken, base, login, refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const scanning = login && !LOGIN_DONE.includes(login.status);
  const wechatEnabled = channels?.wechat.enabled ?? false;

  async function begin() {
    setError(undefined);
    setCode("");
    try {
      const view = await startImLogin(base, adminToken, roomId, {
        channel,
        ownerName,
        ...(channel === "wechat" ? { acceptRisk } : {}),
      });
      setLogin(view);
    } catch (reason) {
      fail(reason);
    }
  }

  async function cancel() {
    if (!login) return;
    await cancelImLogin(base, adminToken, login.id).then(setLogin, fail);
  }

  async function sendCode() {
    if (!login) return;
    await submitImLoginCode(base, adminToken, login.id, code).then(setLogin, fail);
  }

  return (
    <div className="room-dialog-layer">
      <button className="room-dialog-scrim" type="button" aria-label="关闭" onClick={onClose} />
      <div
        className="invite-dialog im-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="im-dialog-title"
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="im-dialog-title">连接 IM</h2>
            <p>
              把飞书或微信接进 <b># {roomId}</b>，在手机上也能给房间发消息。消息以{" "}
              <b>{ownerName}</b> 的身份发出，任务结果和需要你回答的提问会回到原来的会话。
            </p>
          </div>
          <button type="button" className="invite-close" aria-label="关闭" onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>

        <div className="invite-dialog-body">
          <div className="invite-create">
            <div className="invite-field">
              <span className="invite-label">渠道</span>
              <div className="duration-segments" role="radiogroup" aria-label="渠道">
                {(["feishu", "wechat"] as const)
                  .filter((item) => item === "feishu" || wechatEnabled)
                  .map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="radio"
                      aria-checked={channel === item}
                      className={channel === item ? "on" : ""}
                      disabled={Boolean(scanning)}
                      onClick={() => setChannel(item)}
                    >
                      {IM_CHANNEL_LABELS[item]}
                    </button>
                  ))}
              </div>
              <small>{scanGuides[channel]}</small>
            </div>

            {channel === "wechat" && (
              <div className="im-risk" role="note">
                <strong>个人微信有风险，默认不启用</strong>
                <p>
                  个人微信没有面向第三方的公开开放平台，这里经腾讯 iLink
                  通道接入，可能违反平台规则，有被限制或封号的风险；
                  消息内容会经过微信服务器。只支持你本人在私聊里发的文字。
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={acceptRisk}
                    disabled={Boolean(scanning)}
                    onChange={(event) => setAcceptRisk(event.target.checked)}
                  />
                  我了解风险，仍要连接
                </label>
              </div>
            )}

            {error && (
              <p className="room-dialog-error" role="alert">
                {error}
              </p>
            )}

            {login && (scanning || login.status !== "cancelled") && (
              <div className="im-login" role="status">
                {login.qrDataUrl && scanning ? (
                  <img
                    className="im-qr"
                    src={login.qrDataUrl}
                    alt={`${IM_CHANNEL_LABELS[login.channel]}扫码二维码`}
                  />
                ) : null}
                <div className="im-login-copy">
                  {login.status === "succeeded" ? (
                    <strong className="im-ok">已连接</strong>
                  ) : login.status === "failed" ? (
                    <strong className="im-failed">连接失败：{login.error}</strong>
                  ) : (
                    <>
                      <strong>
                        {login.status === "waiting_scan"
                          ? `请用${IM_CHANNEL_LABELS[login.channel]}扫描二维码`
                          : loginHints[login.status]}
                      </strong>
                      {login.qrUrl && login.channel === "feishu" && (
                        <small>
                          也可以在手机上直接打开
                          <a href={login.qrUrl} target="_blank" rel="noreferrer">
                            这个链接
                          </a>
                        </small>
                      )}
                      {login.error && <small className="im-failed">{login.error}</small>}
                    </>
                  )}
                  {login.status === "need_code" && (
                    <form
                      className="im-code"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void sendCode();
                      }}
                    >
                      <input
                        inputMode="numeric"
                        autoFocus
                        value={code}
                        maxLength={8}
                        aria-label="配对码"
                        onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                      />
                      <button type="submit" className="primary" disabled={code.length < 4}>
                        提交
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )}

            {scanning ? (
              <button
                type="button"
                className="invite-submit secondary"
                onClick={() => void cancel()}
              >
                取消扫码
              </button>
            ) : (
              <button
                type="button"
                className="invite-submit"
                disabled={channel === "wechat" && !acceptRisk}
                onClick={() => void begin()}
              >
                {login?.status === "succeeded"
                  ? "再连接一个"
                  : `扫码连接${IM_CHANNEL_LABELS[channel]}`}
              </button>
            )}
          </div>

          <section className="invite-list" aria-label="本房间的 IM 连接">
            <h3>
              已连接
              <span>{connections.length}</span>
            </h3>
            {connections.length === 0 ? (
              <p className="invite-empty">还没有接入 IM。</p>
            ) : (
              <ul>
                {connections.map((connection) => {
                  const state =
                    connection.status === "connected"
                      ? "active"
                      : connection.status === "paused"
                        ? "expired"
                        : "revoked";
                  return (
                    <li key={connection.id} className={`invite-item ${state}`}>
                      <div className="invite-item-main">
                        <span className={`invite-dot ${state}`} aria-hidden="true" />
                        <div className="invite-item-copy">
                          <strong>
                            {IM_CHANNEL_LABELS[connection.channel]} · {connection.label}
                          </strong>
                          <small>
                            {statusLabels[connection.status]} · 以 {connection.ownerName} 发言
                            {connection.lastInboundAt
                              ? ` · 最近收到 ${new Date(connection.lastInboundAt).toLocaleString(
                                  "zh-CN",
                                  {
                                    month: "numeric",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}`
                              : " · 还没收到消息"}
                            {connection.detail && connection.status !== "connected"
                              ? ` · ${connection.detail}`
                              : ""}
                          </small>
                        </div>
                        <div className="invite-item-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() =>
                              void setImConnectionPaused(
                                base,
                                adminToken,
                                connection.id,
                                connection.status !== "paused",
                              ).then(refresh, fail)
                            }
                          >
                            {connection.status === "paused" ? "恢复" : "暂停"}
                          </button>
                          <button
                            type="button"
                            className="ghost danger"
                            onClick={() => {
                              if (
                                window.confirm(
                                  "断开后，这个 IM 发来的消息不再进入房间，保存的凭据也会删除。确定断开？",
                                )
                              ) {
                                void removeImConnection(base, adminToken, connection.id).then(
                                  refresh,
                                  fail,
                                );
                              }
                            }}
                          >
                            断开
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="invite-empty im-usage">
              在 IM 里 @ Agent 的名字就能让它干活；回复 /help 查看用法，/room 房间ID 切换房间。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

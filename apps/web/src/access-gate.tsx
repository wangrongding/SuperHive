import { useCallback, useEffect, useState } from "react";
import { App, serverBase } from "./App";
import {
  GUEST_TOKEN_KEY,
  OWNER_TOKEN_KEY,
  fetchAccess,
  formatDeadline,
  parseInviteHash,
  previewInvite,
  redeemInvite,
  type GuestSession,
  type InvitePreview,
} from "./access-api";
import { localized, t, useLocale } from "./i18n";

export type GuestAccess = GuestSession;

type GateState =
  | { kind: "loading" }
  | { kind: "owner"; ownerToken?: string }
  | { kind: "guest"; guest: GuestAccess }
  | { kind: "redeem"; token: string; preview?: InvitePreview; error?: string }
  | { kind: "none"; reason: "no_invite" | "expired" | "revoked" | "unreachable"; detail?: string };

const reasonText: Record<Extract<GateState, { kind: "none" }>["reason"], string> = localized(
  () => ({
    no_invite: t("这个房间需要邀请才能进入。请向房主要一个邀请链接。"),
    expired: t("你的访问期限已到。请联系房主续期，或要一个新的邀请链接。"),
    revoked: t("房主已把你移出这个房间。"),
    unreachable: t("无法连接 Hive Server，请确认服务已启动并检查网络。"),
  }),
);

/** 把邀请参数从地址栏去掉，只留房间，避免刷新或分享时再次用到已用过的链接 */
function stripInviteFromHash(roomId: string) {
  window.history.replaceState(window.history.state, "", `#${roomId}`);
}

/** 登录参数用过就从地址栏去掉：刷新、截图、分享时不再带着它 */
function stripLoginFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("login");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** 设备列表里显示的名字：系统 + 浏览器，够分辨就行 */
export function deviceName(userAgent = navigator.userAgent): string {
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : t("其他设备");
  const app = /Lark|Feishu/i.test(userAgent)
    ? t("飞书")
    : /MicroMessenger/.test(userAgent)
      ? t("微信")
      : /Edg\//.test(userAgent)
        ? "Edge"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Firefox\//.test(userAgent)
            ? "Firefox"
            : /Safari\//.test(userAgent)
              ? "Safari"
              : t("浏览器");
  return `${os} · ${app}`;
}

async function ownerLogin(base: string, ticket: string, name: string): Promise<string> {
  const response = await fetch(`${base}/api/owner-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, deviceName: name }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error ?? t("登录链接无效或已过期。"));
  return body.token;
}

/**
 * 访问入口：本机房主直接进入；带邀请链接的先兑换成访客会话；
 * 已有访客会话的按会话进入；都没有就提示需要邀请。到期或被移除时回到这里。
 */
const UNREACHABLE_RETRY_MS = 2_000;

export function AccessGate() {
  useLocale();
  const [base] = useState(serverBase);
  const [state, setState] = useState<GateState>({ kind: "loading" });

  const evaluate = useCallback(async () => {
    const invite = parseInviteHash(window.location.hash);
    const login = new URLSearchParams(window.location.search).get("login") ?? undefined;
    const guestToken = localStorage.getItem(GUEST_TOKEN_KEY) ?? undefined;
    let ownerToken = localStorage.getItem(OWNER_TOKEN_KEY) ?? undefined;
    try {
      let access = await fetchAccess(base, guestToken ?? ownerToken);
      // 登录链接（二维码、飞书卡片按钮）：这台设备还不是房主时，换一个房主设备会话
      if (login) {
        stripLoginFromUrl();
        if (access.role !== "owner") {
          try {
            ownerToken = await ownerLogin(base, login, deviceName());
            localStorage.removeItem(GUEST_TOKEN_KEY);
            localStorage.setItem(OWNER_TOKEN_KEY, ownerToken);
            access = await fetchAccess(base, ownerToken);
          } catch (reason) {
            setState({
              kind: "none",
              reason: "no_invite",
              detail: reason instanceof Error ? reason.message : String(reason),
            });
            return;
          }
        }
      }
      if (access.role === "owner") {
        if (invite.token && invite.roomId) stripInviteFromHash(invite.roomId);
        setState({ kind: "owner", ...(ownerToken ? { ownerToken } : {}) });
        return;
      }
      if (access.role === "guest" && guestToken) {
        if (invite.token) stripInviteFromHash(access.roomId);
        setState({ kind: "guest", guest: { ...access, token: guestToken } });
        return;
      }
      if (invite.token) {
        const preview = await previewInvite(base, invite.token).catch(() => undefined);
        setState({ kind: "redeem", token: invite.token, ...(preview ? { preview } : {}) });
        return;
      }
      setState({ kind: "none", reason: access.role === "none" ? access.reason : "no_invite" });
    } catch (reason) {
      setState({
        kind: "none",
        reason: "unreachable",
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [base]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  // 连不上通常是 Server 正在重启（开发时代码更新、升级）：自动重试，恢复后直接进入，不用手动刷新
  const unreachable = state.kind === "none" && state.reason === "unreachable";
  useEffect(() => {
    if (!unreachable) return;
    const timer = window.setInterval(() => void evaluate(), UNREACHABLE_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [evaluate, unreachable]);

  if (state.kind === "loading") return null;
  if (state.kind === "owner") {
    return <App {...(state.ownerToken ? { ownerToken: state.ownerToken } : {})} />;
  }
  if (state.kind === "guest") {
    return (
      <App guest={state.guest} onAccessLost={(reason) => setState({ kind: "none", reason })} />
    );
  }
  return (
    <div className="login-shell">
      <main className="login-card access-card">
        <section className="login-form-panel">
          {state.kind === "redeem" ? (
            <RedeemForm
              preview={state.preview}
              error={state.error}
              onSubmit={async (username) => {
                try {
                  const session = await redeemInvite(base, state.token, username);
                  localStorage.setItem(GUEST_TOKEN_KEY, session.token);
                  localStorage.setItem("ai-hive.username", session.username);
                  stripInviteFromHash(session.roomId);
                  setState({ kind: "guest", guest: session });
                } catch (reason) {
                  setState({
                    ...state,
                    error: reason instanceof Error ? reason.message : String(reason),
                  });
                }
              }}
            />
          ) : (
            <NoAccess
              reason={state.reason}
              detail={state.detail}
              onOwnerToken={(token) => {
                localStorage.removeItem(GUEST_TOKEN_KEY);
                localStorage.setItem(OWNER_TOKEN_KEY, token);
                void evaluate();
              }}
              onRetry={() => void evaluate()}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function RedeemForm({
  preview,
  error,
  onSubmit,
}: {
  preview: InvitePreview | undefined;
  error: string | undefined;
  onSubmit: (username: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(localStorage.getItem("ai-hive.username") ?? "");
  const [busy, setBusy] = useState(false);
  const unusable =
    preview?.state === "expired"
      ? t("这个邀请已经过期，请向房主要一个新邀请。")
      : preview?.state === "revoked"
        ? t("这个邀请已被房主撤销。")
        : undefined;
  return (
    <>
      <div className="login-form-heading">
        <h2>{preview ? t("加入 # {0}", { 0: preview.roomId }) : t("加入房间")}</h2>
        <p className="login-copy">
          {preview && !unusable
            ? t("这是一个限时邀请，{0}。", { 0: formatDeadline(preview.expiresAt) })
            : t("使用邀请链接加入。")}
        </p>
      </div>
      {unusable ? (
        <p className="room-dialog-error" role="alert">
          {unusable}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const clean = username.trim();
            if (!clean || busy) return;
            setBusy(true);
            void onSubmit(clean).finally(() => setBusy(false));
          }}
        >
          <label htmlFor="invite-username">{t("你的用户名")}</label>
          <input
            id="invite-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={32}
            placeholder={t("例如 alice…")}
            autoComplete="username"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !username.trim()}>
            <span>{busy ? t("正在加入…") : t("加入")}</span>
          </button>
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}

function NoAccess({
  reason,
  detail,
  onOwnerToken,
  onRetry,
}: {
  reason: Extract<GateState, { kind: "none" }>["reason"];
  detail: string | undefined;
  onOwnerToken: (token: string) => void;
  onRetry: () => void;
}) {
  const [token, setToken] = useState("");
  const [showOwner, setShowOwner] = useState(false);
  return (
    <>
      <div className="login-form-heading">
        <h2>{reason === "unreachable" ? t("连接失败") : t("需要邀请")}</h2>
        <p className="login-copy">{reasonText[reason]}</p>
        {reason === "unreachable" && (
          <p className="fine-print" role="status">
            {t("正在自动重试，服务恢复后会直接进入。")}
          </p>
        )}
        {detail && <p className="fine-print">{detail}</p>}
      </div>
      <button type="button" className="access-retry" onClick={onRetry}>
        {t("重新检查")}
      </button>
      {showOwner ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) onOwnerToken(token.trim());
          }}
        >
          <label htmlFor="owner-token">{t("房主接入令牌")}</label>
          <input
            id="owner-token"
            value={token}
            type="password"
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("在 Server 所在电脑的页面或启动日志里找到")}
          />
          <button type="submit">
            <span>{t("以房主身份进入")}</span>
          </button>
        </form>
      ) : (
        <button type="button" className="access-owner-link" onClick={() => setShowOwner(true)}>
          {t("我是房主，从别的电脑访问")}
        </button>
      )}
    </>
  );
}

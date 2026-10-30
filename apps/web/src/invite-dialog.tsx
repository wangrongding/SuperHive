import { useCallback, useEffect, useState } from "react";
import type { Invite, Participant } from "@ai-hive/protocol";
import {
  DURATION_PRESETS,
  createGuestAgent,
  createInvite,
  expiresSoon,
  formatDeadline,
  formatRemaining,
  listInvites,
  removeGuest,
  renewGuest,
  renewInvite,
  revokeInvite,
} from "./access-api";
import { copyTextToClipboard } from "./clipboard";

type DurationChoice = { kind: "preset"; minutes: number | null } | { kind: "custom" };

const CUSTOM_LIMITS = { hours: { min: 1, max: 24 * 365 }, days: { min: 1, max: 365 } } as const;

/** 1 小时 / 12 小时 / 24 小时 / 永久 / 自定义（步进器 + 小时/天），返回分钟数，null 为永久 */
export function DurationPicker({
  onChange,
  defaultMinutes = 24 * 60,
}: {
  onChange: (minutes: number | null | undefined) => void;
  defaultMinutes?: number | null;
}) {
  const [choice, setChoice] = useState<DurationChoice>({ kind: "preset", minutes: defaultMinutes });
  const [amount, setAmount] = useState(3);
  const [unit, setUnit] = useState<"hours" | "days">("days");
  const limits = CUSTOM_LIMITS[unit];
  const customMinutes = amount * (unit === "days" ? 24 * 60 : 60);
  // 上限（365 天）与服务端 LIMITS.maxInviteMinutes 一致
  const customValid = Number.isInteger(amount) && amount >= limits.min && amount <= limits.max;

  useEffect(() => {
    if (choice.kind === "preset") onChange(choice.minutes);
    // 无效的自定义时长返回 undefined，调用方据此禁用提交
    else onChange(customValid ? customMinutes : undefined);
  }, [choice, customMinutes, customValid, onChange]);

  const clamp = (value: number) => Math.min(limits.max, Math.max(limits.min, value));

  return (
    <div className="duration-picker">
      <div className="duration-segments" role="radiogroup" aria-label="有效期">
        {DURATION_PRESETS.map((preset) => {
          const on = choice.kind === "preset" && choice.minutes === preset.minutes;
          return (
            <button
              key={preset.label}
              type="button"
              role="radio"
              aria-checked={on}
              className={on ? "on" : ""}
              onClick={() => setChoice({ kind: "preset", minutes: preset.minutes })}
            >
              {preset.label}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={choice.kind === "custom"}
          className={choice.kind === "custom" ? "on" : ""}
          onClick={() => setChoice({ kind: "custom" })}
        >
          自定义
        </button>
      </div>
      {choice.kind === "custom" && (
        <div className="duration-custom">
          <div className="duration-stepper">
            <button
              type="button"
              aria-label="减少"
              disabled={amount <= limits.min}
              onClick={() => setAmount((value) => clamp(value - 1))}
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              aria-label="自定义时长"
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                setAmount(digits ? Number(digits) : 0);
              }}
              onBlur={() => setAmount((value) => clamp(value || limits.min))}
            />
            <button
              type="button"
              aria-label="增加"
              disabled={amount >= limits.max}
              onClick={() => setAmount((value) => clamp(value + 1))}
            >
              +
            </button>
          </div>
          <div className="duration-unit" role="radiogroup" aria-label="时长单位">
            {(["hours", "days"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={unit === value}
                className={unit === value ? "on" : ""}
                onClick={() => {
                  setUnit(value);
                  setAmount((current) =>
                    Math.min(CUSTOM_LIMITS[value].max, Math.max(CUSTOM_LIMITS[value].min, current)),
                  );
                }}
              >
                {value === "hours" ? "小时" : "天"}
              </button>
            ))}
          </div>
          <span className="duration-preview">
            {customValid
              ? formatDeadline(new Date(Date.now() + customMinutes * 60_000).toISOString())
              : `请输入 ${limits.min}–${limits.max}`}
          </span>
        </div>
      )}
    </div>
  );
}

function inviteState(invite: Invite, now: number): "revoked" | "expired" | "active" {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) return "expired";
  return "active";
}

const inviteStateLabels = { revoked: "已撤销", expired: "已到期", active: "有效" } as const;

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 房主生成限时邀请：选有效期与是否允许调度 Agent，复制链接发给任意多人。
 * 下方是本房间的邀请链接：有效的可复制、续期、撤销（对凭它进来的所有人一起生效），失效的默认收起。
 */
export function InviteDialog({
  base,
  adminToken,
  roomId,
  linkFor,
  onClose,
}: {
  base: string;
  adminToken: string;
  roomId: string;
  linkFor: (token: string) => string;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState<number | null | undefined>(24 * 60);
  const [allowAgents, setAllowAgents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ link: string; invite: Invite; copied: boolean }>();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [renewing, setRenewing] = useState<string>();
  const [renewMinutes, setRenewMinutes] = useState<number | null | undefined>(24 * 60);
  const [copiedId, setCopiedId] = useState<string>();
  const [showInactive, setShowInactive] = useState(false);
  const now = Date.now();

  const refresh = useCallback(
    () =>
      listInvites(base, adminToken, roomId).then(
        (payload) => setInvites(payload.invites ?? []),
        (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
      ),
    [adminToken, base, roomId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));

  async function copy(id: string, link: string) {
    try {
      await copyTextToClipboard(link);
      setCopiedId(id);
      window.setTimeout(
        () => setCopiedId((current) => (current === id ? undefined : current)),
        2000,
      );
    } catch {
      setError(`浏览器未允许自动复制，请手动复制：${link}`);
    }
  }

  async function submit() {
    if (minutes === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await createInvite(base, adminToken, roomId, minutes, allowAgents);
      const link = linkFor(result.token);
      const copied = await copyTextToClipboard(link).then(
        () => true,
        () => false,
      );
      setCreated({ link, invite: result.invite, copied });
      void refresh();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  const active = invites.filter((invite) => inviteState(invite, now) === "active");
  const inactive = invites.filter((invite) => inviteState(invite, now) !== "active");

  const renderInvite = (invite: Invite) => {
    const state = inviteState(invite, now);
    const link = invite.token ? linkFor(invite.token) : undefined;
    return (
      <li key={invite.id} className={`invite-item ${state}`}>
        <div className="invite-item-main">
          <span className={`invite-dot ${state}`} aria-hidden="true" />
          <div className="invite-item-copy">
            <strong>{formatDeadline(invite.expiresAt)}</strong>
            <small>
              {inviteStateLabels[state]}
              {state === "active" && invite.expiresAt
                ? ` · ${formatRemaining(invite.expiresAt, now)}`
                : ""}
              {` · 已有 ${invite.uses} 人加入`}
              {invite.allowAgents ? " · 可直接调度 Agent" : ""}
            </small>
          </div>
          {state !== "revoked" && renewing !== invite.id && (
            <div className="invite-item-actions">
              {link && state === "active" && (
                <button type="button" className="ghost" onClick={() => void copy(invite.id, link)}>
                  {copiedId === invite.id ? "已复制" : "复制链接"}
                </button>
              )}
              <button type="button" className="ghost" onClick={() => setRenewing(invite.id)}>
                续期
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  if (
                    invite.uses === 0 ||
                    window.confirm(
                      `撤销后，凭这个链接加入的 ${invite.uses} 人会立即被断开。确定撤销？`,
                    )
                  ) {
                    void revokeInvite(base, adminToken, invite.id).then(refresh, fail);
                  }
                }}
              >
                撤销
              </button>
            </div>
          )}
        </div>
        {renewing === invite.id && (
          <div className="invite-renew">
            <span>从现在起续期，凭这个链接已加入的人一起延长：</span>
            <DurationPicker onChange={setRenewMinutes} />
            <div className="invite-renew-buttons">
              <button type="button" className="ghost" onClick={() => setRenewing(undefined)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={renewMinutes === undefined}
                onClick={() =>
                  void renewInvite(base, adminToken, invite.id, renewMinutes ?? null)
                    .then(() => {
                      setRenewing(undefined);
                      return refresh();
                    })
                    .catch(fail)
                }
              >
                确认续期
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label="关闭邀请弹窗"
        onClick={onClose}
      />
      <div
        className="invite-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-dialog-title"
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="invite-dialog-title">邀请成员</h2>
            <p>
              邀请别人加入 <b># {roomId}</b>。链接有效期内谁拿到都能用，到期后所有人一起失效。
            </p>
          </div>
          <button type="button" className="invite-close" aria-label="关闭" onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>

        <div className="invite-dialog-body">
          <form
            className="invite-create"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="invite-field">
              <span className="invite-label">有效期</span>
              <DurationPicker onChange={setMinutes} />
              <small>
                到期后，凭这个链接进来的人和他们带进来的 Agent 会被断开，已发的消息保留。
              </small>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={allowAgents}
              className="invite-switch"
              onClick={() => setAllowAgents((value) => !value)}
            >
              <span>
                <strong>允许对方直接让房间里的 Agent 干活</strong>
                <small>
                  关闭时，对方 @ 你的 Agent 需要你点「批准」才会执行。你的 Agent
                  可能有本机完全权限。
                </small>
              </span>
              <i className="switch-control" aria-hidden="true">
                <b />
              </i>
            </button>

            {error && (
              <p className="room-dialog-error" role="alert">
                {error}
              </p>
            )}

            {created && (
              <div className="invite-created" role="status">
                <div className="invite-created-head">
                  <strong>
                    {created.copied ? "已复制邀请链接" : "邀请链接已生成，请手动复制"}
                  </strong>
                  <small>{formatDeadline(created.invite.expiresAt)} · 可以发给多人</small>
                </div>
                <div className="invite-link-row">
                  <code>{created.link}</code>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void copy(created.invite.id, created.link)}
                  >
                    {copiedId === created.invite.id ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              className="invite-submit"
              disabled={busy || minutes === undefined}
            >
              {busy ? "正在生成…" : created ? "再生成一个链接" : "生成并复制链接"}
            </button>
          </form>

          <section className="invite-list" aria-label="本房间的邀请">
            <h3>
              有效的链接
              <span>{active.length}</span>
            </h3>
            {active.length === 0 ? (
              <p className="invite-empty">还没有有效的邀请链接。</p>
            ) : (
              <ul>{active.map(renderInvite)}</ul>
            )}
            {inactive.length > 0 && (
              <>
                <button
                  type="button"
                  className="invite-toggle"
                  aria-expanded={showInactive}
                  onClick={() => setShowInactive((value) => !value)}
                >
                  {showInactive ? "收起" : "显示"}已到期 / 已撤销的链接 · {inactive.length}
                </button>
                {showInactive && <ul className="inactive">{inactive.map(renderInvite)}</ul>}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 成员列表里访客的期限：不到 1 小时高亮，到期显示已到期 */
export function GuestAccessBadge({ participant, now }: { participant: Participant; now: number }) {
  const access = participant.access;
  if (!access) return null;
  const ended = access.ended || (access.expiresAt !== null && Date.parse(access.expiresAt) <= now);
  const label = ended
    ? `${access.sponsorName ? `${access.sponsorName} 带入 · ` : "访客 · "}${access.revoked ? "已移除" : "已到期"}`
    : `${access.sponsorName ? `${access.sponsorName} 带入 · ` : "访客 · "}${formatRemaining(access.expiresAt, now)}`;
  return (
    <span
      className={`guest-badge ${ended ? "ended" : expiresSoon(access.expiresAt, now) ? "soon" : ""}`}
      title={formatDeadline(access.expiresAt)}
    >
      {label}
    </span>
  );
}

/** 房主对访客的操作：续期（访客带入的 Agent 跟着延长）或移除 */
export function GuestMemberActions({
  participant,
  base,
  adminToken,
  onError,
}: {
  participant: Participant;
  base: string;
  adminToken: string;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState<number | null | undefined>(24 * 60);
  const [busy, setBusy] = useState(false);
  const access = participant.access;
  // 访客带入的 Agent 跟随访客，只能给访客本人续期或移除访客
  if (!access || access.sponsorName) return null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setOpen(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="guest-actions">
      {open ? (
        <div className="guest-renew" role="group" aria-label={`为 ${participant.username} 续期`}>
          <DurationPicker onChange={setMinutes} />
          <div className="guest-renew-buttons">
            <button
              type="button"
              className="primary"
              disabled={busy || minutes === undefined}
              onClick={() =>
                void run(() => renewGuest(base, adminToken, access.sessionId, minutes ?? null))
              }
            >
              从现在起续期
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 被移除（或链接被撤销）的不能续期，只能重新邀请；自然到期的可以直接续期拉回来 */}
          {!access.revoked && (
            <button type="button" disabled={busy} onClick={() => setOpen(true)}>
              续期
            </button>
          )}
          {!access.ended && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(`移除 ${participant.username}？他和他带入的 Agent 会立即被断开。`)
                ) {
                  void run(() => removeGuest(base, adminToken, access.sessionId));
                }
              }}
            >
              移除
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 访客带入自己的 Agent：生成只能进本房间、与访客同期限的接入命令 */
export function GuestAgentDialog({
  base,
  guestToken,
  expiresAt,
  onClose,
}: {
  base: string;
  guestToken: string;
  expiresAt: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [command, setCommand] = useState<string>();
  const [copied, setCopied] = useState(false);
  return (
    <div className="room-dialog-layer">
      <button className="room-dialog-scrim" type="button" aria-label="关闭" onClick={onClose} />
      <div
        className="room-dialog invite-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-agent-title"
      >
        <header className="room-dialog-header">
          <div>
            <h2 id="guest-agent-title">带入我的 Agent</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        <form
          className="room-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            const clean = name.trim();
            if (!clean) return;
            setBusy(true);
            setError(undefined);
            void createGuestAgent(base, guestToken, clean)
              .then((result) => setCommand(result.command))
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : String(reason)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label className="room-field">
            <span>Agent 名字</span>
            <input
              value={name}
              maxLength={32}
              placeholder="例如 alice-claude"
              onChange={(event) => setName(event.target.value)}
            />
            <small>
              它只能进入这个房间，和你一样{formatDeadline(expiresAt)}
              ；你到期或被移除时，它也会一起离开。
            </small>
          </label>
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
          {command && (
            <div className="invite-created" role="status">
              <strong>在你自己的电脑上运行（可加 --provider claude 等参数）</strong>
              <code>{command}</code>
              <button
                type="button"
                onClick={() =>
                  void copyTextToClipboard(command).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? "已复制" : "复制命令"}
              </button>
            </div>
          )}
          <footer className="room-dialog-footer">
            <button type="submit" disabled={busy || !name.trim() || Boolean(command)}>
              生成接入命令
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

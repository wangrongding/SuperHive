import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invite, Participant } from "@superhive/protocol";
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
  setGuestAgentPaused,
  renewInvite,
  revokeInvite,
} from "./access-api";
import { copyTextToClipboard } from "./clipboard";
import { agentJoinLink, parseJoinInput } from "./join-link";
import { localized, t } from "./i18n";
import { Button, IconButton, buttonClass } from "./button";

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
      <div className="duration-segments" role="radiogroup" aria-label={t("有效期")}>
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
          {t("自定义")}
        </button>
      </div>
      {choice.kind === "custom" && (
        <div className="duration-custom">
          <div className="duration-stepper">
            <button
              type="button"
              className="duration-stepper-step"
              aria-label={t("减少")}
              disabled={amount <= limits.min}
              onClick={() => setAmount((value) => clamp(value - 1))}
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              aria-label={t("自定义时长")}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                setAmount(digits ? Number(digits) : 0);
              }}
              onBlur={() => setAmount((value) => clamp(value || limits.min))}
            />
            <button
              type="button"
              className="duration-stepper-step"
              aria-label={t("增加")}
              disabled={amount >= limits.max}
              onClick={() => setAmount((value) => clamp(value + 1))}
            >
              +
            </button>
          </div>
          <div className="duration-unit" role="radiogroup" aria-label={t("时长单位")}>
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
                {value === "hours" ? t("小时") : t("天")}
              </button>
            ))}
          </div>
          <span className="duration-preview">
            {customValid
              ? formatDeadline(new Date(Date.now() + customMinutes * 60_000).toISOString())
              : t("请输入 {0}–{1}", { 0: limits.min, 1: limits.max })}
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

const inviteStateLabels = localized(
  () => ({ revoked: t("已撤销"), expired: t("已到期"), active: t("有效") }) as const,
);

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
  const [showTrace, setShowTrace] = useState(true);
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
      setError(t("浏览器未允许自动复制，请手动复制：{0}", { 0: link }));
    }
  }

  async function submit() {
    if (minutes === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await createInvite(base, adminToken, roomId, minutes, allowAgents, showTrace);
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
              {t(" · 已有 {0} 人加入", { 0: invite.uses })}
              {invite.allowAgents ? t(" · 可直接调度 Agent") : ""}
              {invite.showTrace === false ? t(" · 只看精简状态") : ""}
            </small>
          </div>
          {state !== "revoked" && renewing !== invite.id && (
            <div className="invite-item-actions">
              {link && state === "active" && (
                <Button size="sm" onClick={() => void copy(invite.id, link)}>
                  {copiedId === invite.id ? t("已复制") : t("复制链接")}
                </Button>
              )}
              <Button size="sm" onClick={() => setRenewing(invite.id)}>
                {t("续期")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                onClick={() => {
                  if (
                    invite.uses === 0 ||
                    window.confirm(
                      t("撤销后，凭这个链接加入的 {0} 人会立即被断开。确定撤销？", {
                        0: invite.uses,
                      }),
                    )
                  ) {
                    void revokeInvite(base, adminToken, invite.id).then(refresh, fail);
                  }
                }}
              >
                {t("撤销")}
              </Button>
            </div>
          )}
        </div>
        {renewing === invite.id && (
          <div className="invite-renew">
            <span>{t("从现在起续期，凭这个链接已加入的人一起延长：")}</span>
            <DurationPicker onChange={setRenewMinutes} />
            <div className="dialog-actions">
              <Button size="sm" onClick={() => setRenewing(undefined)}>
                {t("取消")}
              </Button>
              <Button
                size="sm"
                variant="primary"
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
                {t("确认续期")}
              </Button>
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
        aria-label={t("关闭邀请弹窗")}
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
            <h2 id="invite-dialog-title">{t("邀请成员")}</h2>
            <p>
              {t("邀请别人加入")} <b># {roomId}</b>
              {t("。链接有效期内谁拿到都能用，到期后所有人一起失效。")}
            </p>
          </div>
          <IconButton className="dialog-close" label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </IconButton>
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
              <span className="invite-label">{t("有效期")}</span>
              <DurationPicker onChange={setMinutes} />
              <small>
                {t("到期后，凭这个链接进来的人和他们带进来的 Agent 会被断开，已发的消息保留。")}
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
                <strong>{t("允许对方直接让房间里的 Agent 干活")}</strong>
                <small>
                  {t(
                    "关闭时，对方 @ 你的 Agent 需要你点「批准」才会执行。你的 Agent 可能有本机完全权限。",
                  )}
                </small>
              </span>
              <i className="switch-control" aria-hidden="true">
                <b />
              </i>
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={showTrace}
              className="invite-switch"
              onClick={() => setShowTrace((value) => !value)}
            >
              <span>
                <strong>{t("让对方看到 Agent 的执行过程")}</strong>
                <small>
                  {t(
                    "打开时，对方在「详情」里能实时看到 Agent 跑的命令、读写的文件和中途说的话（已遮掉密钥）。关闭时只看到「执行中」这类精简状态。",
                  )}
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
                    {created.copied ? t("已复制邀请链接") : t("邀请链接已生成，请手动复制")}
                  </strong>
                  <small>
                    {t("{0} · 可以发给多人", { 0: formatDeadline(created.invite.expiresAt) })}
                  </small>
                </div>
                <div className="invite-link-row">
                  <code>{created.link}</code>
                  <Button size="sm" onClick={() => void copy(created.invite.id, created.link)}>
                    {copiedId === created.invite.id ? t("已复制") : t("复制")}
                  </Button>
                </div>
              </div>
            )}

            <div className="dialog-actions">
              <Button type="submit" variant="primary" disabled={busy || minutes === undefined}>
                {busy ? t("正在生成…") : created ? t("再生成一个链接") : t("生成并复制链接")}
              </Button>
            </div>
          </form>

          <section className="invite-list" aria-label={t("本房间的邀请")}>
            <h3>
              {t("有效的链接")}
              <span>{active.length}</span>
            </h3>
            {active.length === 0 ? (
              <p className="invite-empty">{t("还没有有效的邀请链接。")}</p>
            ) : (
              <ul>{active.map(renderInvite)}</ul>
            )}
            {inactive.length > 0 && (
              <>
                <Button
                  variant="link"
                  className="invite-toggle"
                  aria-expanded={showInactive}
                  onClick={() => setShowInactive((value) => !value)}
                >
                  {t("{0}已到期 / 已撤销的链接 · {1}", {
                    0: showInactive ? t("收起") : t("显示"),
                    1: inactive.length,
                  })}
                </Button>
                {showInactive && <ul className="inactive">{inactive.map(renderInvite)}</ul>}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 成员列表里访客的期限（嵌在成员第二行）：不到 1 小时高亮，结束后显示已到期或已移除 */
export function GuestAccessBadge({ participant, now }: { participant: Participant; now: number }) {
  const access = participant.access;
  if (!access) return null;
  const ended = access.ended || (access.expiresAt !== null && Date.parse(access.expiresAt) <= now);
  const label = `${access.sponsorName ? t("{0} 带入", { 0: access.sponsorName }) : t("访客")} · ${
    ended
      ? access.revoked
        ? t("已移除")
        : t("已到期")
      : access.paused
        ? t("已暂停")
        : formatRemaining(access.expiresAt, now)
  }`;
  return (
    <span
      className={`guest-badge ${ended || access.paused ? "ended" : expiresSoon(access.expiresAt, now) ? "soon" : ""}`}
      title={formatDeadline(access.expiresAt)}
    >
      {label}
    </span>
  );
}

/**
 * 房主对访客的操作：名字右侧的「⋯」（悬停成员行时出现），点开浮层续期（访客带入的 Agent 跟着延长）或移出。
 * 访客带进来的 Agent 没有自己的期限，浮层里换成暂停 / 恢复和单独移出。
 * 浮层渲染到 body 并用 fixed 定位，避免被侧栏的滚动容器裁掉；空间不够时向上展开。
 */
export function GuestMemberActions({
  participant,
  base,
  adminToken,
  now,
  onError,
}: {
  participant: Participant;
  base: string;
  adminToken: string;
  now: number;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState<number | null | undefined>(24 * 60);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; right: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const access = participant.access;

  const place = useCallback(() => {
    // 以整行为锚点，浮层贴着成员行下方（或上方）出现，不压住这一行的期限文字
    const trigger = triggerRef.current;
    const rect = (trigger?.closest(".member") ?? trigger)?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPosition(
      spaceBelow >= 360
        ? { top: rect.bottom + 6, right }
        : { bottom: window.innerHeight - rect.top + 6, right },
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    // 侧栏滚动时跟着重新定位
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  if (!access) return null;
  const guestAgent = Boolean(access.sponsorName);
  const ended = access.ended || (access.expiresAt !== null && Date.parse(access.expiresAt) <= now);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setOpen(false);
      setConfirmRemove(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="guest-actions">
      <button
        ref={triggerRef}
        type="button"
        className={`guest-actions-trigger ${open ? "open" : ""}`}
        aria-label={
          guestAgent
            ? t("管理 Agent {0}", { 0: participant.username })
            : t("管理访客 {0}", { 0: participant.username })
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // 不触发成员行的「@ 他」
          event.stopPropagation();
          setOpen((value) => !value);
          setConfirmRemove(false);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            className="guest-popover"
            role="dialog"
            // 浮层经 portal 渲染，React 事件仍会冒泡到成员行：别让点按钮变成「@ 他」
            onClick={(event) => event.stopPropagation()}
            aria-label={t("管理访客 {0}", { 0: participant.username })}
            style={position}
          >
            <header>
              <strong>{participant.username}</strong>
              <small>
                {guestAgent && !ended
                  ? access.paused
                    ? t("已暂停，恢复后它会自己重新连上")
                    : t("{0} 带入，期限跟着 {0}", { 0: access.sponsorName })
                  : ended
                    ? access.revoked
                      ? t("已被移除，需要重新邀请")
                      : t("已于 {0} 到期", {
                          0: formatDeadline(access.expiresAt).replace(t(" 到期"), ""),
                        })
                    : `${formatDeadline(access.expiresAt)} · ${formatRemaining(access.expiresAt, now)}`}
              </small>
            </header>
            {guestAgent && !ended && (
              <section>
                <span className="guest-popover-label">
                  {access.paused
                    ? t("恢复后它在对方电脑上的进程会在几秒内重新连上")
                    : t("暂停会立即断开它，恢复前接不到活；不用对方重新接入")}
                </span>
                <Button
                  variant="primary"
                  block
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      setGuestAgentPaused(base, adminToken, access.sessionId, !access.paused),
                    )
                  }
                >
                  {access.paused ? t("恢复") : t("暂停")}
                </Button>
              </section>
            )}
            {!guestAgent && !access.revoked && (
              <section>
                <span className="guest-popover-label">
                  {ended ? t("续期后可重新进入") : t("从现在起续期")}
                </span>
                <DurationPicker onChange={setMinutes} />
                <Button
                  variant="primary"
                  block
                  disabled={busy || minutes === undefined}
                  onClick={() =>
                    void run(() => renewGuest(base, adminToken, access.sessionId, minutes ?? null))
                  }
                >
                  {busy ? t("正在续期…") : t("确认续期")}
                </Button>
              </section>
            )}
            {!ended && (
              <footer>
                {confirmRemove ? (
                  <>
                    <span>
                      {guestAgent
                        ? t("它会被立即断开，之后都连不上；要再进来得由 {0} 重新带入。", {
                            0: access.sponsorName,
                          })
                        : t("他和他带入的 Agent 会被立即断开。")}
                    </span>
                    <Button size="sm" onClick={() => setConfirmRemove(false)}>
                      {t("取消")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(() => removeGuest(base, adminToken, access.sessionId))
                      }
                    >
                      {t("确认移除")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" tone="danger" onClick={() => setConfirmRemove(true)}>
                    {t("移出房间")}
                  </Button>
                )}
              </footer>
            )}
          </div>,
          document.body,
        )}
    </span>
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
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="room-dialog invite-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-agent-title"
      >
        <header className="room-dialog-header">
          <div>
            <h2 id="guest-agent-title">{t("带入我的 Agent")}</h2>
          </div>
          <IconButton className="dialog-close" label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </IconButton>
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
            <span>{t("Agent 名字")}</span>
            <input
              value={name}
              maxLength={32}
              placeholder={t("例如 alice-claude")}
              onChange={(event) => setName(event.target.value)}
            />
            <small>
              {t("它只能进入这个房间，和你一样{0} ；你到期或被移除时，它也会一起离开。", {
                0: formatDeadline(expiresAt),
              })}
            </small>
          </label>
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
          {command && (
            <div className="invite-created" role="status">
              {(() => {
                const target = parseJoinInput(command);
                return target?.kind === "agent" ? (
                  <>
                    <strong>
                      {t("装了 SuperHive 客户端的话，点这里选一个本机 Agent，它会在后台加入：")}
                    </strong>
                    <a
                      className={buttonClass(
                        { variant: "primary", size: "sm" },
                        "invite-client-link",
                      )}
                      href={agentJoinLink(target)}
                    >
                      {t("用 SuperHive 客户端加入")}
                    </a>
                    <span>{t("没装客户端，就在你自己的电脑上运行下面的命令：")}</span>
                  </>
                ) : null;
              })()}
              <strong>{t("在你自己的电脑上运行（可加 --provider claude 等参数）")}</strong>
              <code>{command}</code>
              <Button
                size="sm"
                className="invite-created-copy"
                onClick={() =>
                  void copyTextToClipboard(command).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? t("已复制") : t("复制命令")}
              </Button>
            </div>
          )}
          <footer className="room-dialog-footer dialog-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !name.trim() || Boolean(command)}
            >
              {t("生成接入命令")}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}

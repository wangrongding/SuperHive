import { useCallback, useEffect, useState } from "react";
import type { KeepAwakeSettings, KeepAwakeState } from "@superhive/protocol";
import type { LocalAgentsState, HostApprover, OwnerDevice } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import { copyTextToClipboard } from "./clipboard";
import { localized, t } from "./i18n";
import { Button } from "./button";
import { isLoopbackUrl } from "./server-url";
import {
  desktopBridge,
  type DesktopFirewallStatus,
  type DesktopLanApi,
  type DesktopLanState,
} from "./desktop-bridge";

/** 侧栏小月亮的悬停说明 */
export function keepAwakeSummary(state: KeepAwakeState): string {
  if (state.status === "failed") {
    return t("熄屏后保持在线没有生效：{0}", { 0: state.detail ?? t("原因未知") });
  }
  return t("熄屏后保持在线：{0}，正在阻止系统睡眠（屏幕照常熄灭）", {
    0: state.reasons.join(t("、")),
  });
}

export const keepAwakeStatusText: Record<KeepAwakeState["status"], string> = localized(() => ({
  active: t("正在阻止系统睡眠"),
  idle: t("现在不需要保持（没有符合条件的 IM 连接或任务），电脑会照常睡眠"),
  battery: t("正在用电池，已暂停保持在线"),
  disabled: t("已关闭，电脑会照常睡眠"),
  unsupported: t("当前系统暂不支持，请在系统电源设置里关闭自动睡眠"),
  failed: t("没有生效"),
}));

/**
 * 房主在其他设备上：查看直接可用；要启动 Agent、改设置先申请管理权，经飞书或 Server 所在电脑批准。
 * compact 用在接入面板里，只留一行说明和按钮
 */
export function HostManageNotice({
  local,
  compact = false,
}: {
  local: LocalAgentsState;
  compact?: boolean;
}) {
  const [error, setError] = useState<string>();
  if (!local.enabled || local.mode !== "device") return null;
  const host = local.hostLabel ?? t("Server 所在电脑");
  if (local.canManage) {
    if (compact) return null;
    return (
      <p className="host-manage-notice granted" role="status">
        {t(
          "这台设备已获准管理 {0}，到 {1} 为止。启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令；只有用完全权限启动时会再逐次确认。",
          {
            0: host,
            1: new Date(local.manageUntil ?? "").toLocaleString(),
          },
        )}
      </p>
    );
  }
  const waiting = local.waitingApproval?.kind === "manage";
  return (
    <div className="host-manage-notice" role="status">
      <p>
        {waiting
          ? local.approvalVia === "im"
            ? t("已发出申请，请在飞书里点「允许」，或到 {0} 上批准。", { 0: host })
            : t("已发出申请，请到 {0} 上打开 SuperHive 批准。", { 0: host })
          : t(
              "你在另一台设备上，可以查看 {0} 上的 Agent 和目录。要启动、停止 Agent 或修改设置，先申请管理权（批准后 12 小时内有效）。获批后启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令。",
              { 0: host },
            )}
      </p>
      {!waiting && (
        <Button
          size="sm"
          className="settings-button"
          onClick={() => {
            setError(undefined);
            local.requestManage().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        >
          {t("申请管理这台电脑")}
        </Button>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 本机页面：其他设备发来的申请，直接在这里批准或拒绝 */
export function HostApprovalsBanner({ local }: { local: LocalAgentsState }) {
  const [error, setError] = useState<string>();
  if (local.mode !== "local" || local.approvals.length === 0) return null;
  return (
    <div className="host-approvals-banner" role="alertdialog" aria-label={t("待批准的申请")}>
      {local.approvals.map((approval) => (
        <div key={approval.id} className="host-approval">
          <p>
            <strong>{t("需要你批准")}</strong>
            {approval.summary}
          </p>
          <small>{t("不是你本人在操作就拒绝，并在设置 → 已登录设备里全部退出。")}</small>
          <div className="dialog-actions host-approval-actions">
            <Button
              size="sm"
              tone="danger"
              onClick={() => local.decideApproval(approval.id, false).catch(fail)}
            >
              {t("拒绝")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => local.decideApproval(approval.id, true).catch(fail)}
            >
              {t("允许")}
            </Button>
          </div>
        </div>
      ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
  function fail(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }
}

/** 设备上的单次操作在等批准：提示去哪里确认 */
export function HostApprovalWaiting({ local }: { local: LocalAgentsState }) {
  const approval = local.waitingApproval;
  if (local.mode !== "device" || approval?.kind !== "action") return null;
  const host = local.hostLabel ?? t("Server 所在电脑");
  return (
    <div className="host-approvals-banner" role="status">
      <div className="host-approval">
        <p>
          <strong>{t("等你确认")}</strong>
          {approval.summary}
        </p>
        <small>
          {local.approvalVia === "im"
            ? t("请在飞书里点「允许」，或到 {0} 上批准；5 分钟内有效。", { 0: host })
            : t("请到 {0} 上打开 SuperHive 批准；5 分钟内有效。", { 0: host })}
        </small>
      </div>
    </div>
  );
}

export function KeepAwakeSettingsGroup({ local }: { local: LocalAgentsState }) {
  const state = local.keepAwake;
  const [error, setError] = useState<string>();
  if (!local.enabled || !state) {
    return (
      <div className="settings-group">
        <p className="settings-note">
          {t(
            "只有在运行 Hive Server 的这台电脑上打开网页，或用扫码、飞书登录的房主设备，才能查看这些设置。",
          )}
        </p>
      </div>
    );
  }
  const disabled = !state.supported || !local.canManage;
  const change = (patch: Partial<KeepAwakeSettings>) => {
    setError(undefined);
    local.updateKeepAwake(patch).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <div className="settings-group">
      <div className="settings-section-heading">
        <div>
          <h4>{t("熄屏后保持在线")}</h4>
          <p>
            {t(
              "屏幕照常熄灭，只是电脑不进入睡眠，飞书消息和 Agent 任务不会中断。只在下面勾选的情况下生效，其他时候照常睡眠。",
            )}
          </p>
        </div>
      </div>
      <SettingsSwitch
        checked={state.whenIm}
        disabled={disabled}
        label={t("连着 IM 时保持在线")}
        description={t("有飞书、微信连接（包括正在重连）时阻止系统睡眠")}
        onChange={(checked) => change({ whenIm: checked })}
      />
      <SettingsSwitch
        checked={state.whenTasks}
        disabled={disabled}
        label={t("Agent 执行任务时保持在线")}
        description={t("有任务正在执行时阻止系统睡眠，执行完就恢复")}
        onChange={(checked) => change({ whenTasks: checked })}
      />
      <SettingsSwitch
        checked={state.onBattery}
        disabled={disabled}
        label={t("用电池时也保持")}
        description={t("默认只在接电源时生效；打开后用电池也不睡眠，比较耗电")}
        onChange={(checked) => change({ onBattery: checked })}
      />
      <p className={`keep-awake-status ${state.status}`} role="status">
        <strong>{keepAwakeStatusText[state.status]}</strong>
        {state.status === "active" && state.reasons.length
          ? t("（{0}）", { 0: state.reasons.join(t("、")) })
          : ""}
        {state.status === "failed" && state.detail ? t("：{0}", { 0: state.detail }) : ""}
      </p>
      <p className="settings-note">
        {t(
          "合上笔记本盖子、手动睡眠仍会睡眠（接着电源和外接显示器时合盖除外）；Hive 重启升级的几秒里不保证。",
        )}
      </p>
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 在其他设备上登录：二维码 / 一次性链接、已登录设备、复制总令牌；在用户菜单的弹窗里 */
/** 桌面端的局域网访问开关：不在桌面端、老版本桌面端、连的是别人起的 Server 时都是 undefined */
export function useDesktopLan(
  api: DesktopLanApi | undefined = desktopBridge()?.lan,
): { state: DesktopLanState; set: (enabled: boolean) => void; api: DesktopLanApi } | undefined {
  const [state, setState] = useState<DesktopLanState>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.get().then(
      (value) => alive && setState(value),
      () => undefined,
    );
    const off = api.onChange((value) => setState(value));
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  const set = useCallback(
    (enabled: boolean) => {
      if (!api) return;
      // 先显示「正在重启」，完成后以桌面端答复为准
      setState((current) => current && { ...current, enabled, restarting: true });
      api.set(enabled).then(setState, () => api.get().then(setState, () => undefined));
    },
    [api],
  );
  if (!api || !state?.managed) return undefined;
  return { state, set, api };
}

/**
 * 发给别的设备的链接和命令现在能不能用：桌面端自己起的 Server 关着局域网时只听 127.0.0.1，
 * 公布的地址也是 127.0.0.1，发出去别人打不开。设了 HIVE_PUBLIC_URL（公布地址不是本机）、
 * 连的是别人起的 Server（lan 为 undefined）或网页版都不受影响。正在切换时以公布地址为准。
 */
export function lanBlocksSharing(input: {
  localMode: LocalAgentsState["mode"];
  lan: { state: DesktopLanState } | undefined;
  advertisedUrl: string | undefined;
}): boolean {
  const { lan } = input;
  if (input.localMode !== "local" || !lan) return false;
  if (lan.state.enabled && !lan.state.restarting) return false;
  return isLoopbackUrl(input.advertisedUrl);
}

const LAN_SWITCH_ID = "settings-lan-access";

/**
 * 把「允许局域网设备访问」开关滚到看得见的地方并短暂高亮。设置弹窗刚打开时开关可能还没渲染出来，
 * 每 16ms 找一次，最多约 1 秒。
 */
export function revealLanSwitch(tries = 60) {
  const target = document.getElementById(LAN_SWITCH_ID);
  if (!target) {
    if (tries > 0) window.setTimeout(() => revealLanSwitch(tries - 1), 16);
    return;
  }
  target.scrollIntoView?.({ block: "center" });
  target.classList.remove("flash");
  // 重新触发动画：连点两次也能再闪一下
  void target.offsetWidth;
  target.classList.add("flash");
  window.setTimeout(() => target.classList.remove("flash"), 2_400);
}

/**
 * 局域网关着时，发给别的设备用的入口（邀请成员、接入 Agent、在其他设备登录、IM）顶上的统一提示：
 * 说明哪样东西别的设备用不了，按钮直达开关。用强调色，不是报错。
 */
export function LanShareNote({ message, onOpen }: { message: string; onOpen: () => void }) {
  return (
    <div className="lan-share-note" role="status">
      <p>{message}</p>
      <Button size="sm" onClick={onOpen}>
        {t("去打开")}
      </Button>
    </div>
  );
}

/** 设备页最上面：「允许局域网设备访问」开关，Windows 上开着时顺带查防火墙 */
export function LanAccessGroup({
  lan,
}: {
  lan: { state: DesktopLanState; set: (enabled: boolean) => void; api: DesktopLanApi };
}) {
  const { state, api } = lan;
  const [firewall, setFirewall] = useState<DesktopFirewallStatus | null>();
  const [copied, setCopied] = useState(false);
  const watch = state.enabled && !state.restarting;
  useEffect(() => {
    setFirewall(undefined);
    if (!watch) return;
    let alive = true;
    api.firewall().then(
      (value) => alive && setFirewall(value),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, watch]);
  const blocked = firewall?.status === "blocked" || firewall?.status === "missing";
  return (
    <>
      <div id={LAN_SWITCH_ID} className="lan-access-switch">
        <SettingsSwitch
          checked={state.enabled}
          disabled={state.restarting}
          label={t("允许局域网设备访问")}
          description={
            state.restarting
              ? t("正在重启 Server，Agent 不会断开…")
              : t("手机或另一台电脑可以扫码、用局域网地址连进来。关掉后只有这台电脑能打开。")
          }
          onChange={lan.set}
        />
      </div>
      {blocked && firewall && (
        <div className="lan-firewall-note" role="status">
          <p>
            {firewall.status === "blocked"
              ? t(
                  "Windows 防火墙还没放行 SuperHive（弹窗时可能点了取消），手机和其他电脑暂时连不上；只在这台电脑上用可以不管。要放行，到「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里勾上这个程序：",
                )
              : t(
                  "Windows 防火墙还没放行 SuperHive，手机和其他电脑可能连不上；只在这台电脑上用可以不管。要放行，到「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里添加这个程序：",
                )}
          </p>
          <code>{firewall.program}</code>
          <Button
            size="sm"
            onClick={() =>
              void copyTextToClipboard(firewall.program).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              })
            }
          >
            {copied ? t("已复制") : t("复制路径")}
          </Button>
        </div>
      )}
    </>
  );
}

export function OwnerDevicesPanel({ local }: { local: LocalAgentsState }) {
  const lan = useDesktopLan();
  const lanOff = local.mode === "local" && lan !== undefined && !lan.state.enabled;
  const [devices, setDevices] = useState<OwnerDevice[]>();
  const [pair, setPair] = useState<{ url: string; expiresAt: string; qrDataUrl: string }>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const enabled = local.enabled;
  const { ownerDevices } = local;
  // 换了监听地址，之前的二维码可能连不上了
  const lanEnabled = lan?.state.enabled;
  useEffect(() => setPair(undefined), [lanEnabled]);
  const refresh = useCallback(() => {
    ownerDevices().then(setDevices, () => setDevices(undefined));
  }, [ownerDevices]);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  // 二维码用过（多了一台设备）或到期就收起
  useEffect(() => {
    if (!pair) return;
    const timer = window.setInterval(() => {
      if (Date.parse(pair.expiresAt) <= Date.now()) setPair(undefined);
      refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [pair, refresh]);
  if (!enabled) return null;
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const copy = (text: string, label: string) => {
    void copyTextToClipboard(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 1_500);
    }, fail);
  };
  return (
    <div className="settings-group owner-devices-panel">
      {local.mode === "local" && lan && <LanAccessGroup lan={lan} />}
      {local.mode === "device" ? null : lanOff ? (
        <LanShareNote
          message={t("局域网访问已关闭，手机和其他电脑扫码也登录不了。")}
          onOpen={() => revealLanSwitch()}
        />
      ) : pair ? (
        <div className="owner-pair">
          <img src={pair.qrDataUrl} alt={t("登录二维码")} width={160} height={160} />
          <div>
            <p>
              {t(
                "用手机相机或飞书扫码，5 分钟内有效，只能用一次。设备要和这台电脑在同一个网络里。",
              )}
            </p>
            <code className="owner-pair-url">{pair.url}</code>
            <div className="owner-pair-actions">
              <Button size="sm" onClick={() => copy(pair.url, "link")}>
                {copied === "link" ? t("已复制") : t("复制链接")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPair(undefined)}>
                {t("收起")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          className="settings-button"
          onClick={() => {
            setError(undefined);
            local.pairOwnerDevice().then(setPair, fail);
          }}
        >
          {t("显示登录二维码")}
        </Button>
      )}
      <h4 className="owner-devices-heading">{t("已登录的设备")}</h4>
      {devices?.length ? (
        <ul className="owner-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <span>
                <strong>
                  {device.name}
                  {device.id === local.deviceId ? t("（这台）") : ""}
                </strong>
                <small>
                  {t("{0}登录 · 最近活跃 {1}", {
                    0: device.source === "im" ? t("经飞书卡片") : t("扫码"),
                    1: new Date(device.lastSeenAt).toLocaleString(),
                  })}
                </small>
              </span>
              {(device.id === local.deviceId || local.canManage) && (
                <Button
                  size="sm"
                  tone="danger"
                  onClick={() => local.revokeOwnerDevice(device.id).then(refresh, fail)}
                >
                  {t("退出登录")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">{t("还没有其他设备登录。")}</p>
      )}
      {local.canManage &&
        (devices?.filter((device) => device.id !== local.deviceId).length ?? 0) > 0 && (
          <Button
            size="sm"
            tone="danger"
            className="settings-button"
            onClick={() => {
              if (!window.confirm(t("退出其他所有已登录的设备？手机丢了或怀疑被盗用时用。")))
                return;
              local.revokeAllOwnerDevices().then(refresh, fail);
            }}
          >
            {local.mode === "device" ? t("退出其他所有设备") : t("全部退出")}
          </Button>
        )}
      {local.mode === "local" && <HostApproversGroup local={local} onError={fail} />}
      {local.mode === "local" && (
        <details className="owner-token-details">
          <summary>{t("房主接入令牌（高级）")}</summary>
          <p className="settings-note">
            {t(
              "这是房主的总钥匙，有完整权限，只在接入远程 Agent 或扫码不方便时使用，不要发给别人。",
            )}
          </p>
          <Button
            size="sm"
            className="settings-button"
            onClick={() => local.ownerToken().then((token) => copy(token, "token"), fail)}
          >
            {copied === "token" ? t("已复制") : t("复制令牌")}
          </Button>
        </details>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 本机：哪些 IM 账号可以在卡片上批准其他设备管理这台电脑 */
export function HostApproversGroup({
  local,
  onError,
}: {
  local: LocalAgentsState;
  onError: (reason: unknown) => void;
}) {
  const [approvers, setApprovers] = useState<HostApprover[]>();
  const { hostApprovers } = local;
  useEffect(() => {
    hostApprovers().then(setApprovers, () => setApprovers(undefined));
  }, [hostApprovers]);
  if (!approvers?.length) return null;
  return (
    <>
      <h4 className="owner-devices-heading">{t("在 IM 里批准")}</h4>
      <p className="settings-note">
        {t(
          "其他设备申请管理这台电脑（启动 Agent、改设置）时，把批准卡推到这些账号。在这台电脑上扫码连接的会自动勾上。",
        )}
      </p>
      {approvers.map((approver) => (
        <SettingsSwitch
          key={approver.connectionId}
          checked={approver.allowed}
          label={approver.label}
          description={
            approver.channel === "feishu"
              ? t("飞书")
              : t("微信（不支持卡片，申请只能在这台电脑上批准）")
          }
          onChange={(checked) =>
            local.setHostApprover(approver.connectionId, checked).then(setApprovers, onError)
          }
        />
      ))}
    </>
  );
}

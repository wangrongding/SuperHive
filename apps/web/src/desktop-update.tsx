/**
 * 桌面端「有新版本」提示：侧栏底部、状态栏里各一个不打扰的入口，点开弹窗看版本号、发布说明摘要。
 * 能在应用里直接更新时给「下载并更新」：确认后弹窗关掉，右下角出一张进度卡片（可以收起到状态栏）→
 * 「重启以更新」，不重启就等下次退出 / 打开时生效；不能（位置只读、老版本桌面端、Release 没传更新包）
 * 或失败时退回「下载」安装包，并说明原因。状态栏弹层里的「检查更新」马上查一次，结果在右下角提示。
 *
 * 「重启以更新」会停掉桌面端起的本机 Hive：有本机 Agent 在执行任务时，卡片里先让人选「等任务做完再重启
 * （推荐）」或「立即重启，中断正在执行的任务」，和网页版（npm）更新同一个口径。等待由桌面端做（每 2 秒查一次，
 * 最多 30 分钟），卡片显示在等谁、可以取消；到上限还没做完就停下来让人再决定，不硬重启。
 * 只在桌面端出现（浏览器里没有 window.superhiveDesktop.updates）。
 *
 * 网页拿不到任何链接：「下载」「完整发布说明」只告诉桌面端打开哪一个，地址由桌面端从自己的检查结果里取，
 * 并且只会是 github.com 上本仓库 Release 下的地址。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppDialog } from "./app-dialog";
import { Icon } from "./app-icons";
import { Button } from "./button";
import {
  desktopBridge,
  type DesktopInstallFailure,
  type DesktopInstallState,
  type DesktopRestartChoice,
  type DesktopRestartWait,
  type DesktopUpdateInfo,
  type DesktopUpdatesApi,
} from "./desktop-bridge";
import { getLocale, t, type Locale } from "./i18n";
import { UpdateCard, UpdateCornerPortal, UpdateProgress } from "./update-card";
import {
  closeDesktopUpdateDialog,
  collapseUpdateCard,
  dismissUpdateNotice,
  expandUpdateCard,
  openDesktopUpdateDialog,
  setDesktopDismissed,
  showUpdateNotice,
  updateCheckPending,
  useUpdateCenter,
} from "./update-center";

/** 发布说明一条里中英文用「 / 」隔开（见 Release 说明的写法），按界面语言取一半；没有分隔就原样 */
export function noteForLocale(note: string, locale: Locale): string {
  const parts = note.split(" / ");
  if (parts.length < 2) return note;
  return (locale === "en" ? parts.slice(1).join(" / ") : parts[0]!).trim() || note;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  // 和访达、GitHub 一样按 1000 进位
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function formatDate(value: string | undefined, locale: Locale): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 订阅桌面端的新版检查结果；不在桌面端（或老版本桌面端）时一直是 undefined */
export function useDesktopUpdate(api: DesktopUpdatesApi | undefined = desktopBridge()?.updates): {
  info: DesktopUpdateInfo | undefined;
  api: DesktopUpdatesApi | undefined;
} {
  const [info, setInfo] = useState<DesktopUpdateInfo>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onChange((next) => {
      if (alive) setInfo(next ?? undefined);
    });
    void api
      .get()
      .then((next) => {
        if (alive) setInfo(next ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return { info, api };
}

/** 不能直接更新 / 更新失败的原因，给人看的说明 */
export function installReasonText(reason: DesktopInstallFailure): string {
  switch (reason) {
    case "translocated":
      return t(
        "SuperHive 是从「下载」等位置直接打开的，系统把它放在只读的临时位置，没法原地更新。把 SuperHive 拖进「应用程序」再打开，以后就能直接更新。",
      );
    case "read-only":
      return t("SuperHive 在只读的磁盘（比如 dmg）里运行，没法原地更新。先把它拖进「应用程序」。");
    case "not-writable":
      return t("SuperHive 所在的文件夹没有写权限，没法原地更新。");
    case "not-installed":
      return t("这个 SuperHive 不是用安装包装的，没法直接更新。");
    case "no-package":
      return t("这个版本没有提供应用内更新包。");
    case "network":
      return t("下载没成功，可能是网络问题。");
    case "checksum":
      return t("下载的文件校验不通过，已经丢弃。");
    case "bad-package":
      return t("更新包的内容不对，已经丢弃。");
    default:
      return t("更新时出了问题。");
  }
}

function percent(received: number, total: number): number | undefined {
  if (!(total > 0)) return undefined;
  return Math.min(100, Math.floor((received / total) * 100));
}

/** 应用内更新的状态；老版本桌面端没有 install / restart 时当作没有（只能下载安装包） */
function installOf(info: DesktopUpdateInfo, api: DesktopUpdatesApi) {
  return api.install && api.restart ? info.install : undefined;
}

/** 这几个阶段在右下角用进度卡片表现（点入口展开卡片），其余（还没开始、失败）点入口打开弹窗 */
function inProgress(state: DesktopInstallState | undefined): boolean {
  return state?.phase === "downloading" || state?.phase === "verifying" || state?.phase === "ready";
}

/** 已下载好、在等 Agent 做完再重启（或等超时了）；老版本桌面端没有 */
function restartWaitOf(install: DesktopUpdateInfo["install"]): DesktopRestartWait | undefined {
  return install?.state.phase === "ready" ? install.restart : undefined;
}

/** 卡片里最多点出几个名字，其余的放进悬停提示 */
const NAMED_AGENTS = 3;

/** 在忙的 Agent 名单：多了只点出前几个；桌面端一时没查到名字时笼统说「本机 Agent」 */
function agentNames(agents: string[]): string {
  if (!agents.length) return t("本机 Agent");
  if (agents.length <= NAMED_AGENTS) return agents.join(t("、"));
  return t("{0} 等 {1} 个 Agent", {
    0: agents.slice(0, NAMED_AGENTS).join(t("、")),
    1: agents.length,
  });
}

/** 点不全名字时，悬停看完整名单 */
function agentsTitle(agents: string[]): string | undefined {
  return agents.length > NAMED_AGENTS ? agents.join(t("、")) : undefined;
}

function waitingTitle(agents: string[]): string {
  return agents.length
    ? t("等 {0} 个 Agent 做完再重启", { 0: agents.length })
    : t("等 Agent 做完再重启");
}

function entryLabelOf(
  info: DesktopUpdateInfo,
  state: DesktopInstallState,
  wait: DesktopRestartWait | undefined,
): string {
  if (wait?.phase === "waiting") return waitingTitle(wait.agents);
  if (state.phase === "ready") return t("重启以更新到 {0}", { 0: info.version });
  if (state.phase === "downloading" || state.phase === "verifying") {
    const progress =
      state.phase === "downloading" ? percent(state.received, state.total) : undefined;
    return progress !== undefined
      ? t("正在下载新版本 {0}%", { 0: progress })
      : t("正在下载新版本…");
  }
  return t("有新版本 {0}", { 0: info.version });
}

/** 侧栏、状态栏里的「有新版本」入口：只是个按钮，弹窗和进度卡片由 DesktopUpdateLayer 统一管 */
export function DesktopUpdateEntry({
  api: injected,
  variant = "sidebar",
}: {
  api?: DesktopUpdatesApi;
  /** sidebar=左栏底部的入口；status=底部状态栏里的一小项 */
  variant?: "sidebar" | "status";
}) {
  const { info, api } = useDesktopUpdate(injected ?? desktopBridge()?.updates);
  const { desktopDismissed } = useUpdateCenter();
  if (!api || !info || desktopDismissed === info.version) return null;
  const install = installOf(info, api);
  const state = install?.state ?? { phase: "idle" as const };
  return (
    <button
      type="button"
      className={
        variant === "status"
          ? "status-item ok desktop-update-status"
          : "sidebar-action desktop-update-entry"
      }
      aria-haspopup="dialog"
      onClick={() => {
        // 下载中、下好了：展开右下角的进度卡片；还没开始、失败：打开弹窗看说明
        if (inProgress(state)) expandUpdateCard();
        else openDesktopUpdateDialog();
      }}
    >
      <span className="desktop-update-dot" aria-hidden="true">
        <Icon name="arrow-up" size={12} />
      </span>
      <span>{entryLabelOf(info, state, restartWaitOf(install))}</span>
    </button>
  );
}

/**
 * 状态栏弹层「检查更新」：桌面端马上查一次（不弹系统对话框），结果在右下角提示。
 * 已经在下载或下好了就直接展开进度卡片；有新版本时打开更新弹窗。
 */
export async function checkDesktopUpdatesNow(api: DesktopUpdatesApi): Promise<void> {
  if (!api.checkNow || updateCheckPending()) return;
  const known = await api.get().catch(() => null);
  if (known && inProgress(installOf(known, api)?.state)) {
    expandUpdateCard();
    return;
  }
  const notice = showUpdateNotice("pending", t("正在检查更新…"));
  try {
    const result = await api.checkNow();
    switch (result.status) {
      case "available": {
        dismissUpdateNotice(notice);
        // 之前在这个页面里点过「忽略这个版本」：人主动来查，重新提示
        setDesktopDismissed(undefined);
        const next = await api.get().catch(() => null);
        if (next && inProgress(installOf(next, api)?.state)) expandUpdateCard();
        else openDesktopUpdateDialog();
        return;
      }
      case "latest":
        showUpdateNotice("ok", t("已是最新版本 {0}", { 0: result.currentVersion }));
        return;
      case "disabled":
        showUpdateNotice("info", t("这是开发版，不检查更新。"));
        return;
      default:
        showUpdateNotice("danger", t("没能检查更新，可能是网络问题，稍后再试。"));
    }
  } catch {
    showUpdateNotice("danger", t("没能检查更新，可能是网络问题，稍后再试。"));
  }
}

/**
 * 桌面端更新的弹窗和右下角进度卡片：只挂一份（UpdateCorner 里），侧栏、状态栏的入口共用。
 * 下载完成或失败时，收起的卡片自己再展开一次，免得错过「重启以更新」。
 */
export function DesktopUpdateLayer({
  api: injected,
  platform = desktopBridge()?.platform,
}: {
  api?: DesktopUpdatesApi | undefined;
  platform?: string | undefined;
}) {
  const { info, api } = useDesktopUpdate(injected ?? desktopBridge()?.updates);
  const center = useUpdateCenter();
  const install = info && api ? installOf(info, api) : undefined;
  const phase = install?.state.phase;
  const wait = restartWaitOf(install);
  const previous = useRef(phase);
  const previousWait = useRef(wait?.phase);
  // 点了「重启以更新」、桌面端说有 Agent 在忙：等人在卡片里选，名单是那一刻查到的
  const [asking, setAsking] = useState<string[]>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if ((before === "downloading" || before === "verifying") && phase !== before) {
      expandUpdateCard();
    }
  }, [phase]);
  useEffect(() => {
    // 开始等（包括从菜单选的）、等到上限：卡片收起着也展开，免得错过
    const before = previousWait.current;
    previousWait.current = wait?.phase;
    if (wait && wait.phase !== before) expandUpdateCard();
  }, [wait]);
  if (!api || !info || center.desktopDismissed === info.version) return null;
  const state = install?.state ?? { phase: "idle" as const };
  const restart = async (choice: DesktopRestartChoice) => {
    if (!api.restart) return;
    setPending(true);
    try {
      const result = await api.restart(choice);
      if (typeof result === "object" && result.status === "busy") {
        setAsking(result.agents);
        expandUpdateCard();
      } else {
        setAsking(undefined);
      }
    } catch {
      setAsking(undefined);
    } finally {
      setPending(false);
    }
  };
  const showCard =
    !center.notice && !center.cardCollapsed && (inProgress(state) || state.phase === "failed");
  return (
    <>
      {showCard && (
        <UpdateCornerPortal>
          <DesktopUpdateCard
            info={info}
            api={api}
            state={state}
            canRetry={Boolean(install?.available)}
            platform={platform}
            wait={wait}
            asking={state.phase === "ready" && !wait ? asking : undefined}
            pending={pending}
            onRestart={(choice) => void restart(choice)}
            onCancelAsk={() => setAsking(undefined)}
          />
        </UpdateCornerPortal>
      )}
      {center.desktopDialog &&
        createPortal(
          <DesktopUpdateDialog
            info={info}
            api={api}
            platform={platform}
            onRestart={() => {
              // 进度和要不要等 Agent 都在右下角的卡片里看
              closeDesktopUpdateDialog();
              expandUpdateCard();
              void restart("check");
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * 右下角的进度卡片：下载进度 →「重启以更新」；有 Agent 在忙时先选等不等、在等时显示等谁；
 * 失败时说明原因，可以重试或下载安装包
 */
function DesktopUpdateCard({
  info,
  api,
  state,
  canRetry,
  platform,
  wait,
  asking,
  pending,
  onRestart,
  onCancelAsk,
}: {
  info: DesktopUpdateInfo;
  api: DesktopUpdatesApi;
  state: DesktopInstallState;
  canRetry: boolean;
  platform: string | undefined;
  wait: DesktopRestartWait | undefined;
  asking: string[] | undefined;
  pending: boolean;
  onRestart: (choice: DesktopRestartChoice) => void;
  onCancelAsk: () => void;
}) {
  const releaseLink = (
    <Button variant="link" size="sm" onClick={() => void api.open("release")}>
      {t("发布说明")}
      <Icon name="external" size={12} />
    </Button>
  );
  const quitHint =
    platform === "win32"
      ? t("不重启的话，下次打开时换上新版本。")
      : t("不重启的话，下次退出时换上新版本。");
  const cancelWait = api.cancelRestart && (
    <Button size="sm" onClick={() => void api.cancelRestart?.()}>
      {wait?.phase === "timeout" ? t("以后再说") : t("取消等待")}
    </Button>
  );
  if (state.phase === "ready" && wait?.phase === "waiting") {
    return (
      <UpdateCard title={waitingTitle(wait.agents)} onCollapse={collapseUpdateCard}>
        <p className="update-card-text" title={agentsTitle(wait.agents)}>
          {t("{0} 还在执行任务，做完后自动重启，最多等 30 分钟。", {
            0: agentNames(wait.agents),
          })}
        </p>
        <UpdateProgress label={t("等 Agent 做完再重启")} />
        <div className="update-card-actions">
          {cancelWait}
          <Button size="sm" tone="danger" disabled={pending} onClick={() => onRestart("now")}>
            {t("立即重启")}
          </Button>
        </div>
      </UpdateCard>
    );
  }
  if (state.phase === "ready" && wait?.phase === "timeout") {
    return (
      <UpdateCard
        title={t("等了 30 分钟，任务还没做完")}
        tone="warn"
        onCollapse={collapseUpdateCard}
      >
        <p className="update-card-text" title={agentsTitle(wait.agents)}>
          {platform === "win32"
            ? t("{0} 还在执行任务。不重启的话，下次打开时换上新版本。", {
                0: agentNames(wait.agents),
              })
            : t("{0} 还在执行任务。不重启的话，下次退出时换上新版本。", {
                0: agentNames(wait.agents),
              })}
        </p>
        <div className="update-card-actions">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => onRestart("wait")}>
            {t("再等 30 分钟")}
          </Button>
          <Button size="sm" tone="danger" disabled={pending} onClick={() => onRestart("now")}>
            {t("立即重启")}
          </Button>
          {cancelWait}
        </div>
      </UpdateCard>
    );
  }
  if (state.phase === "ready" && asking) {
    return (
      <UpdateCard
        title={t("新版本 {0} 已下载好", { 0: info.version })}
        tone="ok"
        onCollapse={collapseUpdateCard}
      >
        <p className="update-card-text" title={agentsTitle(asking)}>
          {t("{0} 正在执行任务，重启将中断它们，请确认：", { 0: agentNames(asking) })}
        </p>
        <div className="update-card-choices">
          <Button
            variant="primary"
            size="sm"
            block
            disabled={pending}
            onClick={() => onRestart("wait")}
          >
            {t("等任务做完再重启（推荐）")}
          </Button>
          <Button size="sm" tone="danger" block disabled={pending} onClick={() => onRestart("now")}>
            {t("立即重启，中断正在执行的任务")}
          </Button>
          <Button variant="ghost" size="sm" block onClick={onCancelAsk}>
            {t("取消")}
          </Button>
        </div>
      </UpdateCard>
    );
  }
  if (state.phase === "ready") {
    return (
      <UpdateCard
        title={t("新版本 {0} 已下载好", { 0: info.version })}
        tone="ok"
        onCollapse={collapseUpdateCard}
      >
        <p className="update-card-text">{quitHint}</p>
        <div className="update-card-actions">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => onRestart("check")}>
            {t("重启以更新")}
          </Button>
          {releaseLink}
        </div>
      </UpdateCard>
    );
  }
  if (state.phase === "failed") {
    return (
      <UpdateCard title={t("没能直接更新")} tone="danger" onCollapse={collapseUpdateCard}>
        <p className="update-card-text">{installReasonText(state.reason)}</p>
        <div className="update-card-actions">
          {canRetry && (
            <Button variant="primary" size="sm" onClick={() => void api.install?.(info.version)}>
              {t("重试")}
            </Button>
          )}
          <Button size="sm" onClick={() => void api.open("download")}>
            {t("下载安装包")}
          </Button>
        </div>
      </UpdateCard>
    );
  }
  const progress = state.phase === "downloading" ? percent(state.received, state.total) : undefined;
  return (
    <UpdateCard title={t("正在下载 {0}", { 0: info.version })} onCollapse={collapseUpdateCard}>
      <UpdateProgress label={t("下载进度")} value={progress} />
      <div className="update-card-actions">
        <span className="update-card-text">
          {state.phase === "verifying"
            ? t("正在校验…")
            : progress !== undefined
              ? t("下载中 {0}%", { 0: progress })
              : t("下载中…")}
        </span>
        {releaseLink}
      </div>
    </UpdateCard>
  );
}

/** 有新版本的弹窗：看版本号、发布说明摘要，确认「下载并更新」后关掉，进度改在右下角看 */
function DesktopUpdateDialog({
  info,
  api,
  platform,
  onRestart,
}: {
  info: DesktopUpdateInfo;
  api: DesktopUpdatesApi;
  platform: string | undefined;
  /** 「重启以更新」：弹窗关掉，要不要等 Agent 在右下角卡片里问 */
  onRestart: () => void;
}) {
  const locale = getLocale();
  const published = formatDate(info.publishedAt, locale);
  const notes = info.notes.map((note) => noteForLocale(note, locale)).filter(Boolean);
  const close = closeDesktopUpdateDialog;
  const install = installOf(info, api);
  const state = install?.state ?? { phase: "idle" as const };
  const canInstall = Boolean(install?.available) && state.phase === "idle";
  const busy = state.phase === "downloading" || state.phase === "verifying";
  const size = formatSize(canInstall ? install!.size : info.assetSize);
  const progress = state.phase === "downloading" ? percent(state.received, state.total) : undefined;
  const isWindows = platform === "win32";
  /** 开始下载：弹窗关掉，右下角出进度卡片 */
  const startInstall = () => {
    void api.install?.(info.version);
    close();
    expandUpdateCard();
  };

  // 不能直接更新或失败时的主按钮：下载安装包
  const download = (
    <Button
      variant="primary"
      onClick={() => {
        void api.open("download");
        close();
      }}
    >
      {state.phase === "failed" ? t("下载安装包") : t("下载")}
      {!canInstall && size && <span className="desktop-update-size">{size}</span>}
    </Button>
  );

  let primary;
  if (state.phase === "ready") {
    primary = (
      <Button variant="primary" onClick={onRestart}>
        {t("重启以更新")}
      </Button>
    );
  } else if (busy) {
    primary = (
      <Button variant="primary" disabled>
        {state.phase === "verifying"
          ? t("正在校验…")
          : progress !== undefined
            ? t("下载中 {0}%", { 0: progress })
            : t("下载中…")}
      </Button>
    );
  } else if (canInstall) {
    primary = (
      <Button variant="primary" onClick={startInstall}>
        {t("下载并更新")}
        {size && <span className="desktop-update-size">{size}</span>}
      </Button>
    );
  } else {
    primary = download;
  }

  let hint: string;
  if (state.phase === "ready") {
    hint = isWindows
      ? t("新版本已下载好。现在不重启的话，下次打开 SuperHive 就是新版本。")
      : t("新版本已下载好。现在不重启的话，下次退出 SuperHive 时自动换上新版本。");
  } else if (busy) {
    hint = isWindows
      ? t("正在后台下载，可以关掉这个窗口继续用。下好后重启就是新版本。")
      : t("正在后台下载，可以关掉这个窗口继续用。下好后重启就是新版本，下载的文件会先校验。");
  } else if (canInstall) {
    hint = isWindows
      ? t(
          "在后台下载新版本，下好后重启就是新版本，也可以等下次打开时再换。房间、消息和设置都会保留。",
        )
      : t(
          "在后台下载新版本，下好后重启就是新版本，也可以等下次退出时再换。房间、消息和设置都会保留。",
        );
  } else {
    hint = isWindows
      ? t("下载后直接运行安装包，会关掉正在运行的 SuperHive 并覆盖安装，房间、消息和设置都会保留。")
      : t(
          "下载后打开 dmg，把 SuperHive 拖进「应用程序」替换旧版，再重新打开。房间、消息和设置都会保留。",
        );
  }
  // 为什么只能手动下载：位置不对、开发版这些要说；Release 没传更新包就不打扰了
  const reasonText =
    state.phase === "failed"
      ? t("没能直接更新：{0}当前版本不受影响，可以下载安装包手动更新。", {
          0: installReasonText(state.reason),
        })
      : install && !install.available && install.reason && install.reason !== "no-package"
        ? installReasonText(install.reason)
        : undefined;

  return (
    <AppDialog
      size="sm"
      title={
        state.phase === "ready"
          ? t("新版本 {0} 已下载好", { 0: info.version })
          : t("有新版本 {0}", { 0: info.version })
      }
      className="desktop-update-dialog"
      onClose={close}
      footer={
        <>
          {primary}
          {state.phase === "failed" && install?.available && (
            <Button onClick={startInstall}>{t("重试")}</Button>
          )}
          {(state.phase === "idle" || state.phase === "failed") && (
            <Button
              onClick={() => {
                setDesktopDismissed(info.version);
                close();
                void api.dismiss(info.version);
              }}
            >
              {t("忽略这个版本")}
            </Button>
          )}
          <Button variant="link" onClick={() => void api.open("release")}>
            {t("完整发布说明")}
            <Icon name="external" size={13} />
          </Button>
        </>
      }
    >
      <p className="desktop-update-meta">
        {published
          ? t("你现在用的是 {0}，新版发布于 {1}。", { 0: info.currentVersion, 1: published })
          : t("你现在用的是 {0}。", { 0: info.currentVersion })}
      </p>
      {notes.length > 0 && (
        <>
          <h3 className="desktop-update-heading">{t("本版改动")}</h3>
          <ul className="desktop-update-notes">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </>
      )}
      {busy && <UpdateProgress label={t("下载进度")} value={progress} />}
      {reasonText && (
        <p className="desktop-update-reason" role="status">
          {reasonText}
        </p>
      )}
      <p className="desktop-update-hint">{hint}</p>
    </AppDialog>
  );
}

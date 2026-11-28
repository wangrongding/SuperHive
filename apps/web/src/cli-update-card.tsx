/**
 * 右下角的「N 个 CLI 可更新」提醒卡片（只给 Server 这台电脑上的本机房主，参考 Orca 的 AgentCliUpdateCard）：
 * 页面打开后等一会儿（CARD_STARTUP_DELAY_MS）再检测一次，有能升级的 CLI 才弹；24 小时内最多弹一次，
 * 点「稍后」、×、「查看」或按 Esc 记下这一批版本，之后只有出了没见过的新版、并且过了 24 小时才再弹。
 *
 * 点「全部更新」先列出要跑的命令确认，再同时开始（服务端最多同时跑 3 个，多的排队）；卡片里每个 CLI 一行，
 * 排队 / 在跑 / 成功 / 失败分开显示，失败的能展开完整输出、单独重试，也可以一次重试所有失败的。
 * 都结束后提示哪些 Agent 要重启（同「重启这 N 个 Agent」）。只能手动升级的列在下面，给可复制的命令。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentCliJob } from "@superhive/protocol";
import { Icon } from "./app-icons";
import { Button } from "./button";
import { JobOutput, pending, useRestartAgents } from "./agent-clis";
import { t } from "./i18n";
import type { AgentCliWithAgents } from "./local-agents";
import {
  BatchConfirm,
  CopyCommand,
  batchClis,
  busyClis,
  manualClis,
  type StatusAgentClis,
  type StatusAgentClisApi,
} from "./status-runtimes";
import { UpdateCard, UpdateCornerPortal } from "./update-card";

/** 页面打开后等多久再检测（和 Orca 一样 15 秒，不和页面启动抢资源） */
export const CARD_STARTUP_DELAY_MS = 15_000;
/** 两次提醒至少隔多久 */
export const CARD_INTERVAL_MS = 24 * 60 * 60_000;
const STORAGE_KEY = "superhive.cliUpdateCard.v1";

/** 记住的提醒：at 是上次弹出或关掉的时间，seen 是关掉时已经提醒过的「CLI@新版本」 */
export type CardMemory = { at?: number; seen: string[] };

export const offerKeys = (tools: readonly AgentCliWithAgents[]) =>
  tools.map((tool) => `${tool.tool}@${tool.latest ?? ""}`);

/** 该不该弹：有没见过的新版，并且离上次弹出或关掉已经过了 24 小时（时钟往回拨也按过了算，最多等 24 小时） */
export function shouldOffer(memory: CardMemory, keys: readonly string[], now: number): boolean {
  if (!keys.some((key) => !memory.seen.includes(key))) return false;
  if (memory.at === undefined) return true;
  const elapsed = now - memory.at;
  return elapsed < 0 || elapsed >= CARD_INTERVAL_MS;
}

export function readCardMemory(storage: Storage | undefined = safeStorage()): CardMemory {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CardMemory>) : {};
    return {
      ...(typeof parsed.at === "number" ? { at: parsed.at } : {}),
      seen: Array.isArray(parsed.seen)
        ? parsed.seen.filter((key): key is string => typeof key === "string").slice(-50)
        : [],
    };
  } catch {
    return { seen: [] };
  }
}

function writeCardMemory(memory: CardMemory, storage: Storage | undefined = safeStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* 隐私模式等写不进去：这次会话里不再弹就行 */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

type Phase = "hidden" | "offer" | "confirm" | "batch";

export function CliUpdateCard({
  state,
  api,
  paused,
  openSettings,
  now = Date.now,
  startupDelayMs = CARD_STARTUP_DELAY_MS,
}: {
  state: StatusAgentClis;
  api: Pick<StatusAgentClisApi, "act">;
  /** 设置弹窗开着：卡片先藏起来（设置里看得到同样的内容），关上后接着显示 */
  paused: boolean;
  openSettings: () => void;
  now?: () => number;
  startupDelayMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>("hidden");
  /** 这一批升级了哪些 CLI（按开始顺序） */
  const [batch, setBatch] = useState<string[]>([]);
  /** 延迟到点那一刻的检测次数：要等它之后的那一次结果 */
  const [armedAt, setArmedAt] = useState<number>();
  const decided = useRef(false);
  const offerRef = useRef<string[]>([]);
  const { reload, loads, tools } = state;

  // 只在打开页面时排一次：到点时记下当时的检测次数，再检测一次
  const loadsRef = useRef(loads);
  loadsRef.current = loads;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setArmedAt(loadsRef.current);
      reloadRef.current();
    }, startupDelayMs);
    return () => window.clearTimeout(timer);
  }, [startupDelayMs]);

  useEffect(() => {
    if (decided.current || armedAt === undefined || loads <= armedAt || !tools) return;
    decided.current = true;
    const upgradable = [...batchClis(tools), ...manualClis(tools)];
    const keys = offerKeys(upgradable);
    const memory = readCardMemory();
    if (!upgradable.length || !shouldOffer(memory, keys, now())) return;
    offerRef.current = keys;
    // 弹出就算提醒过一次：没理它、刷新页面，24 小时内也不再弹
    writeCardMemory({ ...memory, at: now() });
    setPhase("offer");
  }, [armedAt, loads, tools, now]);

  const auto = useMemo(() => batchClis(tools), [tools]);
  const manual = useMemo(() => manualClis(tools), [tools]);

  /** 稍后 / 关掉：记下这一批版本，没见过的新版出来、过了 24 小时才再弹 */
  const dismiss = () => {
    const memory = readCardMemory();
    const keys = phase === "offer" || phase === "confirm" ? offerRef.current : [];
    writeCardMemory({ at: now(), seen: [...new Set([...memory.seen, ...keys])] });
    setPhase("hidden");
  };

  if (phase === "hidden" || paused) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    dismiss();
  };

  const startAll = (items: readonly AgentCliWithAgents[]) => {
    setBatch((current) => [...new Set([...current, ...items.map((tool) => tool.tool)])]);
    setPhase("batch");
    void state.upgradeMany(items);
  };

  let title: string;
  let tone: "ok" | "danger" | undefined;
  let body: ReactNode;

  if (phase === "batch") {
    const rows = batch.map((tool) => ({
      tool,
      info: tools?.find((item) => item.tool === tool),
      job: state.jobs[tool],
      starting: state.starting.includes(tool),
      startError: state.startErrors[tool],
    }));
    const status = (row: (typeof rows)[number]) =>
      row.starting || (row.job && pending(row.job))
        ? "busy"
        : row.startError || row.job?.state === "failed"
          ? "failed"
          : row.job?.state === "succeeded"
            ? "done"
            : "busy";
    const failed = rows.filter((row) => status(row) === "failed");
    const done = rows.filter((row) => status(row) === "done");
    const running = rows.length - failed.length - done.length;
    const restartable = done.flatMap((row) =>
      (row.info?.agents ?? []).filter((agent) => agent.status !== "stopped"),
    );
    title = running
      ? t("正在更新 {0}/{1} 个 CLI", { 0: done.length + failed.length + 1, 1: rows.length })
      : failed.length
        ? t("{0} 个 CLI 更新失败", { 0: failed.length })
        : t("{0} 个 CLI 已更新", { 0: done.length });
    tone = running ? undefined : failed.length ? "danger" : "ok";
    const retryable = failed
      .map((row) => row.info)
      .filter((info): info is AgentCliWithAgents => Boolean(info && batchClis([info]).length));
    body = (
      <>
        <ul className="cli-update-rows">
          {rows.map((row) => (
            <BatchRow
              key={row.tool}
              name={row.info?.name ?? row.tool}
              status={status(row)}
              job={row.job}
              starting={row.starting}
              startError={row.startError}
              {...(row.info && batchClis([row.info]).length
                ? { onRetry: () => void state.upgradeMany([row.info!]) }
                : {})}
            />
          ))}
        </ul>
        {!running && (
          <div className="update-card-actions">
            {restartable.length > 0 ? (
              <RestartAgents api={api} agents={restartable} />
            ) : (
              done.length > 0 && (
                <p className="update-card-text">{t("这台电脑上还没有用这些 CLI 的 Agent。")}</p>
              )
            )}
            {retryable.length > 1 && (
              <Button size="sm" onClick={() => startAll(retryable)}>
                {t("重试 {0} 个失败的", { 0: retryable.length })}
              </Button>
            )}
          </div>
        )}
      </>
    );
  } else {
    title = t("{0} 个 CLI 可更新", { 0: auto.length + manual.length });
    body = (
      <>
        {phase === "confirm" ? (
          <BatchConfirm
            items={auto}
            onCancel={() => setPhase("offer")}
            onConfirm={() => startAll(auto)}
          />
        ) : (
          <>
            {auto.length > 0 && (
              <ul className="cli-update-rows">
                {auto.map((info) => (
                  <li key={info.tool} className="cli-update-row">
                    <span className="cli-update-name">{info.name}</span>
                    <Versions info={info} />
                  </li>
                ))}
              </ul>
            )}
            {manual.length > 0 && (
              <div className="cli-update-manual">
                <span className="cli-update-section">{t("需要手动更新")}</span>
                <ul className="cli-update-rows">
                  {manual.map((info) => (
                    <li key={info.tool} className="cli-update-row manual">
                      <span className="cli-update-name">{info.name}</span>
                      <Versions info={info} />
                      {info.plan?.kind === "manual" && info.plan.command ? (
                        <CopyCommand command={info.plan.command} />
                      ) : (
                        <span className="cli-update-reason">
                          {info.nodeGap
                            ? t("新版需要 Node {0}，这台电脑用的是 Node {1}。", {
                                0: info.nodeGap.required,
                                1: info.nodeGap.current,
                              })
                            : info.plan?.kind === "manual"
                              ? info.plan.reason
                              : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="update-card-actions">
              {auto.length > 0 && (
                <Button size="sm" variant="primary" onClick={() => setPhase("confirm")}>
                  {auto.length > 1 ? t("全部更新") : t("更新")}
                </Button>
              )}
              <Button size="sm" onClick={dismiss}>
                {t("稍后")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  dismiss();
                  openSettings();
                }}
              >
                {t("查看")}
              </Button>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <UpdateCornerPortal>
      <div className="cli-update-card" onKeyDown={onKeyDown}>
        <UpdateCard
          title={title}
          {...(tone ? { tone } : {})}
          // 升级进行中收起到状态栏（状态栏显示「正在升级…」，点开看每一行）；结束了是 ×
          {...(phase === "batch" && busyClis(state).length
            ? { onCollapse: () => setPhase("hidden") }
            : { onClose: dismiss })}
        >
          {body}
        </UpdateCard>
      </div>
    </UpdateCornerPortal>
  );
}

function Versions({ info }: { info: AgentCliWithAgents }) {
  return (
    <span className="cli-update-versions mono">
      {info.version ?? t("版本未知")}
      <span aria-label={t("可升级到")}> → </span>
      {info.latest}
    </span>
  );
}

function BatchRow({
  name,
  status,
  job,
  starting,
  startError,
  onRetry,
}: {
  name: string;
  status: "busy" | "failed" | "done";
  job: AgentCliJob | undefined;
  starting: boolean;
  startError: string | undefined;
  onRetry?: () => void;
}) {
  const queued = job?.state === "queued";
  return (
    <li className={`cli-update-row ${status}`} aria-label={name}>
      <span className="cli-update-state" aria-hidden="true">
        {status === "busy" ? (
          queued || starting ? (
            <span className="cli-update-dot" />
          ) : (
            <span className="update-notice-spinner" />
          )
        ) : (
          <Icon name={status === "done" ? "check" : "alert"} size={13} />
        )}
      </span>
      <span className="cli-update-name">{name}</span>
      <span className="cli-update-detail">
        {status === "done"
          ? t("已升级到 {0}", { 0: job?.versionAfter ?? "" })
          : status === "failed"
            ? t("失败")
            : starting
              ? t("正在核对命令…")
              : queued
                ? t("排队中")
                : job?.progress || t("正在升级…")}
      </span>
      {status === "failed" && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {t("重试")}
        </Button>
      )}
      {status === "failed" && (
        <div className="cli-update-failure">
          <span>{startError ?? job?.reason}</span>
          {job && <JobOutput job={job} />}
        </div>
      )}
    </li>
  );
}

function RestartAgents({
  api,
  agents,
}: {
  api: Pick<StatusAgentClisApi, "act">;
  agents: readonly { id: string; name: string }[];
}) {
  const { restarting, result, restart } = useRestartAgents(api);
  return (
    <>
      <p className="update-card-text">
        {result ??
          t("这些 Agent 重启后才用上新版：{0}", {
            0: agents.map((agent) => agent.name).join(t("、")),
          })}
      </p>
      {!result && (
        <Button size="sm" disabled={restarting} onClick={() => void restart(agents)}>
          {restarting ? t("正在重启…") : t("重启这 {0} 个 Agent", { 0: agents.length })}
        </Button>
      )}
    </>
  );
}

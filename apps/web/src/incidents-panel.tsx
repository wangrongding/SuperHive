import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Incident,
  IncidentActionRequest,
  IncidentSettings,
  IncidentsResponse,
  Participant,
  RuleProposal,
} from "@superhive/protocol";
import { AvatarGlyph } from "./avatar";
import { Select, type SelectOption } from "./select";
import { Stepper } from "./stepper";
import type { LocalAgentsState } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import { localized, t } from "./i18n";
import { serverString } from "./server-text";
import "./styles/incidents.css";
import { Button } from "./button";

export const incidentStatusLabel: Record<Incident["status"], string> = localized(() => ({
  open: t("待处理"),
  fixing: t("修复中"),
  fix_submitted: t("等合入"),
  resolved: t("已解决"),
  escalated: t("需要你处理"),
  ignored: t("已忽略"),
}));

const sourceLabel: Record<Incident["source"], string> = localized(() => ({
  invocation: t("Agent 调用"),
  server: "Server",
  protocol: t("协议"),
  web: t("网页"),
}));

export type IncidentGroups = {
  /** 我们的问题里还要人或 Agent 管的：升级给人的在最前，其余按最近出现 */
  active: Incident[];
  /** 我们的问题里已解决、已忽略的 */
  closed: Incident[];
  /** 外部原因：只重试和提示，不派修 */
  external: Incident[];
  /** 说不清是谁的 */
  unknown: Incident[];
};

export function groupIncidents(incidents: readonly Incident[]): IncidentGroups {
  const groups: IncidentGroups = { active: [], closed: [], external: [], unknown: [] };
  for (const incident of incidents) {
    if (incident.origin === "external") groups.external.push(incident);
    else if (incident.origin === "unknown") groups.unknown.push(incident);
    else if (incident.status === "resolved" || incident.status === "ignored")
      groups.closed.push(incident);
    else groups.active.push(incident);
  }
  groups.active.sort(
    (a, b) =>
      Number(b.status === "escalated") - Number(a.status === "escalated") ||
      Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
  );
  return groups;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 左侧「故障」入口和顶栏任务目录下拉一样，只给这台电脑上的房主 */
export function incidentsAvailable(
  isOwner: boolean,
  local: Pick<LocalAgentsState, "enabled" | "mode">,
): boolean {
  return isOwner && Boolean(local.enabled) && local.mode === "local";
}

/** 故障入口上的数字：我们自己的问题里还没人管的（待处理、升级给人的）+ 待批准的规则提议 */
export function unhandledIncidentCount(data: IncidentsResponse): number {
  return (
    data.incidents.filter(
      (incident) =>
        incident.origin === "internal" &&
        (incident.status === "open" || incident.status === "escalated"),
    ).length + data.proposals.filter((proposal) => proposal.status === "pending").length
  );
}

/** 进左侧「需要你处理」的：升级给人的故障单、待批准的规则提议 */
export type IncidentAttentionItem = {
  id: string;
  kind: "incident" | "proposal";
  title: string;
};

export function incidentAttentionItems(
  data: IncidentsResponse | undefined,
): IncidentAttentionItem[] {
  if (!data) return [];
  return [
    ...data.incidents
      .filter((incident) => incident.status === "escalated")
      .map((incident) => ({ id: incident.id, kind: "incident" as const, title: incident.title })),
    ...data.proposals
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => ({ id: proposal.id, kind: "proposal" as const, title: proposal.text })),
  ];
}

export type IncidentsState = {
  /** 只有这台电脑上的房主页面用得上 */
  enabled: boolean;
  data: IncidentsResponse | undefined;
  error: string | undefined;
  /** 入口上的数字；还没拉到详情时先用 Server 推来的「需要你处理」数 */
  unhandled: number;
  attentionItems: IncidentAttentionItem[];
  refresh(): void;
  /** 存好了返回 true；失败时错误写进 error */
  updateSettings(patch: Partial<IncidentSettings>): Promise<boolean>;
  act(id: string, action: IncidentActionRequest["action"]): void;
  decide(id: string, decision: "approve" | "reject" | "retire"): void;
};

/**
 * 本机房主页面上的故障单。Server 每次有变化都推 incidents.changed（signal 随之变），
 * 这里稍等一下再拉 /api/local/incidents：同一种错误连着出现时只拉一次。
 */
export function useIncidents(
  local: LocalAgentsState,
  enabled: boolean,
  signal: { attention: number; version: number } | undefined,
): IncidentsState {
  const [data, setData] = useState<IncidentsResponse>();
  const [error, setError] = useState<string>();
  const { incidents } = local;
  const refresh = useCallback(() => {
    incidents().then(
      (next) => {
        setData(next);
        setError(undefined);
      },
      (reason: unknown) => setError(failureText(reason)),
    );
  }, [incidents]);
  const version = signal?.version;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(refresh, version === undefined ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh, version]);
  const run = (action: Promise<unknown>) =>
    void action.then(refresh, (reason: unknown) => setError(failureText(reason)));
  const shown = enabled ? data : undefined;
  return {
    enabled,
    data: shown,
    error: enabled ? error : undefined,
    unhandled: shown ? unhandledIncidentCount(shown) : enabled ? (signal?.attention ?? 0) : 0,
    attentionItems: incidentAttentionItems(shown),
    refresh,
    updateSettings: (patch) =>
      local.updateIncidentSettings(patch).then(
        () => {
          refresh();
          return true;
        },
        (reason: unknown) => {
          setError(failureText(reason));
          return false;
        },
      ),
    act: (id, action) => run(local.incidentAction(id, action)),
    decide: (id, decision) => run(local.decideRuleProposal(id, decision)),
  };
}

/** 派修设置里能选的 Agent：名字、运行时、在线状态 */
export type RoomAgent = Pick<Participant, "username" | "status" | "provider">;

/** 次数的范围：派修阈值和每日上限 1–20，修失败几次找人 1–5 */
const LIMITS = {
  threshold: { min: 1, max: 20 },
  dailyLimit: { min: 1, max: 20 },
  maxAttempts: { min: 1, max: 5 },
} as const;

/** 连点 −/+ 时停下来再存，免得每点一下发一次 */
const NUMBER_SAVE_DELAY_MS = 500;
const SAVED_NOTE_MS = 2000;

/**
 * 自动派修怎么派：在「故障」面板顶部点「派修设置」展开，不放进偏好设置。
 * 每项改了就存（开关本来就是即时生效的，几个选项互不依赖，没必要再点一次「保存」），存好了轻提示「已保存」。
 * 派活消息以房主（当前用户）的名义发出，不用填。开关关着时下面的选项收淡但仍能改：
 * 常见顺序是先选好人再打开，折起来就得先打开才能配，开着却没配好又派不出去。
 */
export function IncidentDispatchSettings({
  data,
  rooms,
  currentRoomId,
  username,
  loadAgents,
  onSave,
}: {
  data: IncidentsResponse;
  rooms: ReadonlyArray<{ id: string; name: string }>;
  currentRoomId: string;
  username: string;
  /** 某个房间的 Agent 成员 */
  loadAgents: (roomId: string) => Promise<RoomAgent[]>;
  onSave: (patch: Partial<IncidentSettings>) => Promise<boolean>;
}) {
  // 改了先在界面上生效，等 Server 推回新设置再以它为准
  const [optimistic, setOptimistic] = useState<Partial<IncidentSettings>>({});
  useEffect(() => setOptimistic({}), [data.settings]);
  const settings = { ...data.settings, ...optimistic };
  const canDispatch = Boolean(data.runningCommit);
  const roomId = settings.roomId ?? currentRoomId;
  const [agents, setAgents] = useState<{ roomId: string; list: RoomAgent[] }>();
  const [agentsError, setAgentsError] = useState(false);
  const [counts, setCounts] = useState(() => countsOf(data.settings));
  const [clearedReviewer, setClearedReviewer] = useState(false);
  const [saved, setSaved] = useState(false);
  const pendingCounts = useRef<Partial<IncidentSettings>>({});
  const countsTimer = useRef<number>(undefined);
  const savedTimer = useRef<number>(undefined);

  useEffect(() => setCounts(countsOf(data.settings)), [data.settings]);

  useEffect(() => {
    let current = true;
    setAgentsError(false);
    loadAgents(roomId).then(
      (list) => current && setAgents({ roomId, list }),
      () => current && setAgentsError(true),
    );
    return () => {
      current = false;
    };
  }, [loadAgents, roomId]);

  // 派活消息以房主的名义发出；房间没存过时按当前房间算，一起存上
  const save = (patch: Partial<IncidentSettings>) => {
    setOptimistic((current) => ({ ...current, ...patch }));
    void onSave({ roomId, requester: username, ...patch }).then((ok) => {
      if (!ok) return setOptimistic({});
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), SAVED_NOTE_MS);
    });
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const flushCounts = () => {
    window.clearTimeout(countsTimer.current);
    const patch = pendingCounts.current;
    pendingCounts.current = {};
    if (Object.keys(patch).length > 0) saveRef.current(patch);
  };
  const flushRef = useRef(flushCounts);
  flushRef.current = flushCounts;
  useEffect(
    () => () => {
      flushRef.current();
      window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const setCount = (key: keyof typeof LIMITS, value: number) => {
    setCounts((current) => ({ ...current, [key]: value }));
    pendingCounts.current = { ...pendingCounts.current, [key]: value };
    window.clearTimeout(countsTimer.current);
    countsTimer.current = window.setTimeout(flushCounts, NUMBER_SAVE_DELAY_MS);
  };

  const roomAgents = agents?.roomId === roomId ? agents.list : undefined;
  const roomName = rooms.find((room) => room.id === roomId)?.name ?? roomId;
  const fixer = settings.fixer ?? "";
  const reviewer = settings.reviewer ?? "";
  const absent = (name: string) =>
    Boolean(name && roomAgents && !roomAgents.some((agent) => sameName(agent.username, name)));
  const roomOptions: SelectOption[] = [
    ...(rooms.some((room) => room.id === roomId) ? [] : [{ value: roomId, label: `# ${roomId}` }]),
    ...rooms.map((room) => ({ value: room.id, label: `# ${room.name}` })),
  ];

  return (
    <>
      <SettingsSwitch
        checked={settings.autoDispatch}
        disabled={!canDispatch}
        label={t("自动派修")}
        description={
          canDispatch
            ? t(
                "同一种错误出现到次数，就派给下面的 Agent 先写复现测试再修，合入仍要人 review；今天已派 {0} 次。",
                { 0: data.dispatchedToday },
              )
            : t("Server 不是从源码仓库运行的，核对不了修复有没有合入，只归类、不派修。")
        }
        onChange={(checked) => save({ autoDispatch: checked })}
      />
      <div className={`incident-settings${settings.autoDispatch ? "" : " muted"}`}>
        <div className="incident-pickers">
          <label className="incident-field">
            <span>{t("在哪个房间派活")}</span>
            <Select
              className="incident-select"
              value={roomId}
              options={roomOptions}
              menuMinWidth={240}
              onChange={(next) => {
                setClearedReviewer(false);
                save({ roomId: next });
              }}
            />
          </label>
          <label className="incident-field">
            <span>{t("修的 Agent")}</span>
            <Select
              className="incident-select"
              value={fixer}
              placeholder={t("选择 Agent")}
              options={agentOptions(roomAgents, fixer)}
              menuMinWidth={220}
              onChange={(next) => {
                // review 的不能和修的同一个：撞上时清掉 review 的，让人重新选
                const clash = Boolean(reviewer) && sameName(next, reviewer);
                setClearedReviewer(clash);
                save(clash ? { fixer: next, reviewer: "" } : { fixer: next });
              }}
            />
          </label>
          <label className="incident-field">
            <span>{t("review 的 Agent")}</span>
            <Select
              className="incident-select"
              value={reviewer}
              options={[
                { value: "", label: t("不指定") },
                ...agentOptions(roomAgents, reviewer, fixer),
              ]}
              menuMinWidth={220}
              onChange={(next) => {
                setClearedReviewer(false);
                save({ reviewer: next });
              }}
            />
          </label>
        </div>
        {(agentsError ||
          absent(fixer) ||
          absent(reviewer) ||
          clearedReviewer ||
          (roomAgents && roomAgents.length === 0)) && (
          <p className="incident-settings-warning" role="alert">
            {agentsError
              ? t("没能读到 #{0} 的成员，稍后再打开试试。", { 0: roomName })
              : roomAgents?.length === 0
                ? t("#{0} 里还没有 Agent，先在那个房间接入一个。", { 0: roomName })
                : clearedReviewer
                  ? t("review 的 Agent 不能和修的是同一个，已清空，请重新选。")
                  : t("{0} 不在 #{1}，请重新选。", {
                      0: [fixer, reviewer].filter(absent).join(t("、")),
                      1: roomName,
                    })}
          </p>
        )}
        <div className="incident-limits">
          {(
            [
              ["threshold", t("出现几次派修")],
              ["dailyLimit", t("每天最多派")],
              ["maxAttempts", t("修失败几次找你")],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="incident-field">
              <span aria-hidden="true">{label}</span>
              <div className="incident-stepper">
                <Stepper
                  value={counts[key]}
                  min={LIMITS[key].min}
                  max={Math.max(LIMITS[key].max, counts[key])}
                  label={label}
                  onChange={(value) => setCount(key, value)}
                />
                <small>{t("次")}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="incident-settings-footer">
        <details className="incident-more">
          <summary>
            {t("自动修复不许改的代码（{0} 处）", { 0: data.protectedPaths.length })}
          </summary>
          <p className="settings-note">
            {t("权限、协作规则、门禁、审计和故障单系统本身；修复动了这些会直接升级给你：{0}", {
              0: data.protectedPaths.join(t("、")),
            })}
          </p>
        </details>
        <span className={`incident-settings-saved${saved ? " shown" : ""}`} role="status">
          {saved && (
            <>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
              {t("已保存")}
            </>
          )}
        </span>
      </div>
    </>
  );
}

function countsOf(settings: IncidentSettings) {
  return {
    threshold: settings.threshold,
    dailyLimit: Math.max(LIMITS.dailyLimit.min, settings.dailyLimit),
    maxAttempts: settings.maxAttempts,
  };
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** 房间里的 Agent：在线的在前，离线的归到「离线」；except 是另一个下拉已选的人，不能再选 */
function agentOptions(
  agents: RoomAgent[] | undefined,
  value: string,
  except?: string,
): SelectOption[] {
  const list = [...(agents ?? [])].sort(
    (a, b) =>
      Number(a.status === "offline") - Number(b.status === "offline") ||
      a.username.localeCompare(b.username),
  );
  const options: SelectOption[] = list.map((agent) => ({
    value: agent.username,
    label: agent.username,
    group: agent.status === "offline" ? t("离线") : t("在线"),
    icon: (
      <span className="avatar agent select-avatar" aria-hidden="true">
        <AvatarGlyph type="agent" name={agent.username} provider={agent.provider} />
      </span>
    ),
    ...(except && sameName(agent.username, except)
      ? { disabled: true, description: t("已选为修的 Agent") }
      : agent.status === "busy"
        ? { description: t("忙碌中") }
        : {}),
  }));
  // 存着的人已经不在这个房间（或成员还没读到）：照样显示出来，别让下拉像是没选
  if (value && !list.some((agent) => sameName(agent.username, value))) {
    options.unshift({ value, label: value });
  }
  return options;
}

export function IncidentsPanel({
  data,
  focusId,
  onAction,
  onDecide,
  onFeedback,
}: {
  data: IncidentsResponse;
  /** 从「需要你处理」点进来的那一条：滚到它、展开现场 */
  focusId?: string;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
  onDecide: (id: string, decision: "approve" | "reject" | "retire") => void;
  onFeedback?: (incident: Incident, contribute?: boolean) => void;
}) {
  const groups = groupIncidents(data.incidents);
  const pending = data.proposals.filter((proposal) => proposal.status === "pending");
  const approved = data.proposals.filter((proposal) => proposal.status === "approved");
  return (
    <div className="incidents">
      {pending.length > 0 && (
        <section aria-label={t("待批准的规则提议")}>
          <h5>{t("待批准的规则提议")}</h5>
          <ul className="incident-list">
            {pending.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                focused={proposal.id === focusId}
                onDecide={onDecide}
              />
            ))}
          </ul>
        </section>
      )}
      <IncidentSection
        title={t("我们的问题")}
        empty={t("没有待处理的故障单。")}
        incidents={groups.active}
        onFeedback={onFeedback}
        focusId={focusId}
        onAction={onAction}
      />
      {approved.length > 0 && (
        <details className="incident-more">
          <summary>{t("已生效的补充规则（{0} 条）", { 0: approved.length })}</summary>
          <p className="settings-note">
            {t("接在所有 Agent 的规则后面，Agent 重启后生效。撤下后不再加进去。")}
          </p>
          <ul className="incident-list">
            {approved.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} onDecide={onDecide} />
            ))}
          </ul>
        </details>
      )}
      {data.lessons.length > 0 && (
        <details className="incident-more">
          <summary>{t("经验库（{0} 条）", { 0: data.lessons.length })}</summary>
          <p className="settings-note">{t("每次修完记下的症状、原因和修法，派修时附给 Agent。")}</p>
          <ul className="incident-list">
            {data.lessons.map((lesson) => (
              <li key={lesson.id} className="incident-lesson">
                <strong>{lesson.title}</strong>
                <small>
                  {[
                    lesson.agentName,
                    when(lesson.createdAt),
                    lesson.commit?.slice(0, 8),
                    lesson.verified ? t("已验证") : t("未验证"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                <dl>
                  <dt>{t("症状")}</dt>
                  <dd>{lesson.symptom}</dd>
                  <dt>{t("原因")}</dt>
                  <dd>{lesson.cause}</dd>
                  <dt>{t("修法")}</dt>
                  <dd>{lesson.fix}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}
      {groups.closed.length > 0 && (
        <IncidentSection
          collapsed
          title={t("已解决、已忽略（{0}）", { 0: groups.closed.length })}
          incidents={groups.closed}
          onFeedback={onFeedback}
          onAction={onAction}
        />
      )}
      {groups.external.length > 0 && (
        <IncidentSection
          collapsed
          title={t("外部原因（{0}）", { 0: groups.external.length })}
          note={t("模型服务、网络、凭证或 Agent 自己的 CLI：只重试和提示，不派修。")}
          incidents={groups.external}
          onFeedback={onFeedback}
          onAction={onAction}
        />
      )}
      {groups.unknown.length > 0 && (
        <IncidentSection
          collapsed
          title={t("说不清是谁的（{0}）", { 0: groups.unknown.length })}
          note={t(
            "旧版 Agent 没给出结构化原因，或是新的失败类型：只记下来，不自动派修，可以手动派。",
          )}
          incidents={groups.unknown}
          onFeedback={onFeedback}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function IncidentSection({
  title,
  note,
  empty,
  incidents,
  collapsed = false,
  focusId,
  onAction,
  onFeedback,
}: {
  title: string;
  note?: string;
  empty?: string;
  incidents: Incident[];
  collapsed?: boolean;
  focusId?: string;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
  onFeedback?: (incident: Incident, contribute?: boolean) => void;
}) {
  const list =
    incidents.length > 0 ? (
      <ul className="incident-list">
        {incidents.map((incident) => (
          <IncidentRow
            key={incident.id}
            incident={incident}
            focused={incident.id === focusId}
            onAction={onAction}
            onFeedback={onFeedback}
          />
        ))}
      </ul>
    ) : empty ? (
      <p className="settings-note">{empty}</p>
    ) : null;
  if (collapsed) {
    return (
      <details className="incident-more">
        <summary>{title}</summary>
        {note && <p className="settings-note">{note}</p>}
        {list}
      </details>
    );
  }
  return (
    <section aria-label={title}>
      <h5>{title}</h5>
      {note && <p className="settings-note">{note}</p>}
      {list}
    </section>
  );
}

function IncidentRow({
  incident,
  focused = false,
  onAction,
  onFeedback,
}: {
  incident: Incident;
  focused?: boolean;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
  onFeedback?: (incident: Incident, contribute?: boolean) => void;
}) {
  const note = serverString(incident.noteText);
  const sample = incident.samples[0];
  const canDispatch =
    incident.origin !== "external" && ["open", "escalated"].includes(incident.status);
  const canReopen = ["resolved", "ignored", "escalated"].includes(incident.status);
  return (
    <li
      className={`incident ${incident.status}${focused ? " focused" : ""}`}
      data-incident-id={incident.id}
    >
      <div className="incident-head">
        <span className={`incident-status ${incident.status}`}>
          {incidentStatusLabel[incident.status]}
        </span>
        <strong title={incident.fingerprint}>{incident.title}</strong>
        <span className="incident-count" title={t("一共出现了 {0} 次", { 0: incident.count })}>
          ×{incident.count}
        </span>
      </div>
      <small>
        {[
          sourceLabel[incident.source],
          t("最近 {0}", { 0: when(incident.lastSeenAt) }),
          incident.failedAttempts > 0
            ? t("修失败 {0} 次", { 0: incident.failedAttempts })
            : undefined,
          incident.fixCommit ? t("修复 {0}", { 0: incident.fixCommit.slice(0, 8) }) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </small>
      {note && <p className="incident-note">{note}</p>}
      <details open={focused || undefined}>
        <summary>{t("现场与派修记录")}</summary>
        {sample && (
          <dl className="incident-sample">
            {sample.route && (
              <>
                <dt>{t("位置")}</dt>
                <dd>{sample.route}</dd>
              </>
            )}
            {(sample.agentName || sample.roomId) && (
              <>
                <dt>{t("在哪")}</dt>
                <dd>
                  {[sample.agentName, sample.provider, sample.roomId ? `#${sample.roomId}` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </>
            )}
            {(sample.detailText || sample.detail) && (
              <>
                <dt>{t("说明")}</dt>
                <dd>{serverString(sample.detailText, sample.detail ?? "")}</dd>
              </>
            )}
            {sample.url && (
              <>
                <dt>{t("页面")}</dt>
                <dd>{sample.url}</dd>
              </>
            )}
            {sample.codeVersion && (
              <>
                <dt>{t("代码版本")}</dt>
                <dd>{sample.codeVersion.slice(0, 12)}</dd>
              </>
            )}
            {sample.stack && (
              <>
                <dt>{t("调用栈")}</dt>
                <dd>
                  <pre>{sample.stack}</pre>
                </dd>
              </>
            )}
          </dl>
        )}
        {incident.dispatches.length > 0 && (
          <ul className="incident-dispatches">
            {incident.dispatches.map((dispatch) => (
              <li key={dispatch.id}>
                {t("第 {0} 次 · {1} · {2}", {
                  0: dispatch.attempt,
                  1: dispatch.agentName,
                  2: when(dispatch.at),
                })}
                {" · "}
                {dispatchOutcomeLabel[dispatch.outcome]}
                {dispatch.commit ? ` · ${dispatch.commit.slice(0, 8)}` : ""}
                {dispatch.reason ? ` · ${dispatch.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="incident-actions">
        {onFeedback && (
          <>
            <Button size="sm" onClick={() => onFeedback(incident)}>
              {t("反馈给 SuperHive")}
            </Button>
            <Button size="sm" onClick={() => onFeedback(incident, true)}>
              {t("让我的 Agent 来修")}
            </Button>
          </>
        )}
        {canDispatch && (
          <Button variant="primary" size="sm" onClick={() => onAction(incident.id, "dispatch")}>
            {t("派修")}
          </Button>
        )}
        {incident.status !== "resolved" && incident.status !== "ignored" && (
          <>
            <Button size="sm" onClick={() => onAction(incident.id, "resolve")}>
              {t("标为已解决")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction(incident.id, "ignore")}>
              {t("忽略")}
            </Button>
          </>
        )}
        {canReopen && (
          <Button size="sm" onClick={() => onAction(incident.id, "reopen")}>
            {t("重新打开")}
          </Button>
        )}
      </div>
    </li>
  );
}

const dispatchOutcomeLabel: Record<Incident["dispatches"][number]["outcome"], string> = localized(
  () => ({
    pending: t("修复中"),
    submitted: t("交了修复"),
    failed: t("没修成"),
    superseded: t("人接手了"),
  }),
);

function ProposalRow({
  proposal,
  focused = false,
  onDecide,
}: {
  proposal: RuleProposal;
  focused?: boolean;
  onDecide: (id: string, decision: "approve" | "reject" | "retire") => void;
}) {
  return (
    <li className={`incident-proposal${focused ? " focused" : ""}`} data-incident-id={proposal.id}>
      <strong>{proposal.text}</strong>
      <small>{t("{0} 提议 · {1}", { 0: proposal.agentName, 1: when(proposal.createdAt) })}</small>
      <p>{proposal.reason}</p>
      <div className="incident-actions">
        {proposal.status === "pending" ? (
          <>
            <Button variant="primary" size="sm" onClick={() => onDecide(proposal.id, "approve")}>
              {t("批准")}
            </Button>
            <Button size="sm" onClick={() => onDecide(proposal.id, "reject")}>
              {t("拒绝")}
            </Button>
          </>
        ) : (
          <Button size="sm" tone="danger" onClick={() => onDecide(proposal.id, "retire")}>
            {t("撤下")}
          </Button>
        )}
      </div>
    </li>
  );
}

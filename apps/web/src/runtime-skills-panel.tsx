import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeCredentialProvider,
  RuntimeSkill,
  RuntimeSkillSource,
} from "@superhive/protocol";
import { Button } from "./button";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { LocalAgentsState, RuntimeSkillsResult } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";

/**
 * 配置面板里的「技能」：这个 CLI 会读到的全局 skills。启停按各 CLI 原生的开关写进它自己的配置；
 * 删除是把目录挪进同级的 .superhive-skill-backups/。Hive 自带的 superhive 和插件带的只能查看。
 * 改的都是这台电脑上的全局设置，终端里的 CLI 也一起变。
 */

export type RuntimeSkillsApi = Pick<
  LocalAgentsState,
  "runtimeSkills" | "readRuntimeSkill" | "toggleRuntimeSkill" | "deleteRuntimeSkill"
>;

const SOURCE_LABELS: Record<RuntimeSkillSource, string> = {
  user: "用户目录",
  shared: "共用目录",
  plugin: "插件",
  system: "CLI 自带",
  superhive: "Hive 自带",
};

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function sourceLabel(skill: Pick<RuntimeSkill, "source" | "plugin">) {
  return skill.source === "plugin" && skill.plugin
    ? t("插件 {0}", { 0: skill.plugin })
    : t(SOURCE_LABELS[skill.source]);
}

export function SkillsSection({
  api,
  provider,
}: {
  api: RuntimeSkillsApi;
  provider: RuntimeCredentialProvider;
}) {
  const [result, setResult] = useState<RuntimeSkillsResult>();
  const [filter, setFilter] = useState("");
  const [viewing, setViewing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const deleteRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const label = RUNTIME_LABELS[provider];
  const { runtimeSkills } = api;

  useEffect(() => {
    runtimeSkills(provider).then(setResult, (reason: unknown) => setError(errorMessage(reason)));
  }, [runtimeSkills, provider]);

  const run = useCallback(async (action: () => Promise<RuntimeSkillsResult>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const next = await action();
      setResult(next);
      return next;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  if (!result) {
    return error ? (
      <p className="settings-note error">{error}</p>
    ) : (
      <p className="settings-note">{t("正在读取…")}</p>
    );
  }
  const { skills } = result;
  const query = filter.trim().toLowerCase();
  const shown = query
    ? skills.skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      )
    : skills.skills;

  return (
    <div className="runtime-config-block runtime-skills">
      <p className="settings-note">
        {skills.toggleLocation
          ? t("启停写在 {0}，改的是这台电脑上 {1} 的全局设置，终端里的 {1} 也一起变。", {
              0: skills.toggleLocation,
              1: label,
            })
          : t("改的是这台电脑上 {0} 的全局设置，终端里的 {0} 也一起变。", { 0: label })}{" "}
        {t("新开的会话生效，正在运行的 Agent 重启后才读到。")}
      </p>
      {skills.note && <p className="settings-note runtime-credential-note">{skills.note}</p>}
      {skills.skills.length > 6 && (
        <input
          type="search"
          className="runtime-skills-filter"
          aria-label={t("按名称或描述筛选技能")}
          placeholder={t("按名称或描述筛选")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      {skills.skills.length === 0 && (
        <p className="settings-note">{t("这些目录里还没有 skill。")}</p>
      )}
      <ul className="runtime-mcp-list runtime-skill-list">
        {shown.map((skill) => (
          <li key={skill.id} className={skill.enabled ? "" : "disabled"}>
            <div>
              <strong>{skill.name}</strong>
              <span className="runtime-credentials-badge">{sourceLabel(skill)}</span>
              {!skill.enabled && <span className="runtime-credentials-badge">{t("已停用")}</span>}
              {skill.description && <span className="runtime-skill-desc">{skill.description}</span>}
              <code>{skill.linkTarget ? `${skill.path} → ${skill.linkTarget}` : skill.path}</code>
              {skill.sharedWith.length > 0 && (
                <small>
                  {t("这个目录 {0} 也会读", {
                    0: skill.sharedWith.map((item) => RUNTIME_LABELS[item]).join(t("、")),
                  })}
                </small>
              )}
              {skill.note && <small>{skill.note}</small>}
            </div>
            <div className="runtime-config-actions">
              <Button
                size="sm"
                aria-expanded={viewing === skill.id}
                onClick={() =>
                  setViewing((current) => (current === skill.id ? undefined : skill.id))
                }
              >
                {viewing === skill.id ? t("收起") : t("查看")}
              </Button>
              {skill.canToggle && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.toggleRuntimeSkill(provider, skill.id, !skill.enabled))
                  }
                >
                  {skill.enabled ? t("停用") : t("启用")}
                </Button>
              )}
              {skill.canDelete && (
                <Button
                  size="sm"
                  tone="danger"
                  ref={(element) => {
                    deleteRefs.current.set(skill.id, element);
                  }}
                  disabled={busy}
                  aria-expanded={deleting === skill.id}
                  onClick={() => setDeleting(skill.id)}
                >
                  {t("删除")}
                </Button>
              )}
            </div>
            {viewing === skill.id && <SkillViewer api={api} provider={provider} id={skill.id} />}
            {deleting === skill.id && (
              <ConfirmPopover
                ariaLabel={t("确认删除技能 {0}", { 0: skill.name })}
                title={t("会同时影响终端里的 {0}", { 0: label })}
                message={
                  <>
                    {t("把 {0} 挪进同级的 .superhive-skill-backups/ 目录，需要时可以挪回来。", {
                      0: skill.path,
                    })}
                    {skill.sharedWith.length > 0 &&
                      ` ${t("这个目录 {0} 也会读，删掉后它们也用不了。", {
                        0: skill.sharedWith.map((item) => RUNTIME_LABELS[item]).join(t("、")),
                      })}`}
                    {skill.linkTarget && ` ${t("这是软链，只挪链接本身，指向的目录不动。")}`}
                  </>
                }
                confirmLabel={t("删除")}
                cancelLabel={t("取消")}
                danger
                busy={busy}
                anchorRef={{ current: deleteRefs.current.get(skill.id) ?? null }}
                onConfirm={() =>
                  void run(() => api.deleteRuntimeSkill(provider, skill.id)).then((next) => {
                    setDeleting(undefined);
                    if (next && "backup" in next) {
                      setDone(t("已删除，备份在 {0}", { 0: String(next.backup) }));
                    }
                  })
                }
                onCancel={() => setDeleting(undefined)}
              />
            )}
          </li>
        ))}
      </ul>
      <details className="runtime-skill-dirs">
        <summary>{t("{0} 读取的目录", { 0: label })}</summary>
        <ul>
          {skills.dirs.map((dir) => (
            <li key={dir.path}>
              <code>{dir.path}</code> <span>{sourceLabel({ source: dir.source })}</span>
              {!dir.exists && <span className="runtime-credentials-badge">{t("不存在")}</span>}
            </li>
          ))}
        </ul>
      </details>
      {done && (
        <p className="settings-note" role="status">
          {done}
        </p>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

function SkillViewer({
  api,
  provider,
  id,
}: {
  api: RuntimeSkillsApi;
  provider: RuntimeCredentialProvider;
  id: string;
}) {
  const [file, setFile] = useState<{ content: string; path: string }>();
  const [error, setError] = useState<string>();
  const { readRuntimeSkill } = api;
  useEffect(() => {
    readRuntimeSkill(provider, id).then(setFile, (reason: unknown) =>
      setError(errorMessage(reason)),
    );
  }, [readRuntimeSkill, provider, id]);
  if (error) return <p className="settings-note error">{error}</p>;
  if (!file) return <p className="settings-note">{t("正在读取…")}</p>;
  return (
    <div className="runtime-skill-viewer">
      <small>{file.path}</small>
      <pre tabIndex={0} aria-label={t("{0} 的内容", { 0: file.path })}>
        {file.content}
      </pre>
    </div>
  );
}

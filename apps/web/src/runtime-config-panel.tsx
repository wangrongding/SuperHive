import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeConfigField,
  RuntimeConfigFile,
  RuntimeCredentialProvider,
  RuntimeMcpServer,
  RuntimeMcpServerInput,
} from "@superhive/protocol";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { LocalAgentsState, RuntimeConfigResult } from "./local-agents";
import { CredentialRow, RestartNotice, RUNTIME_LABELS } from "./runtime-credentials";
import "./styles/runtime-config.css";
import { Button } from "./button";
import { SkillsSection, type RuntimeSkillsApi } from "./runtime-skills-panel";

/**
 * Agent CLI 卡片上「配置」点开的面板（只给 Server 所在电脑上的本机房主）：分接入、行为、MCP、提示词、
 * 高级五组，读写的都是这个 CLI 自己的全局配置，终端里的 CLI 也一起变。密钥默认打码，原始配置整份原文
 * 要先确认才显示；每次保存前提示会影响终端里的 CLI，保存后按运行时说明要不要重启。
 */

export type RuntimeConfigApi = Pick<
  LocalAgentsState,
  | "runtimeConfig"
  | "updateRuntimeFields"
  | "putRuntimeMcp"
  | "deleteRuntimeMcp"
  | "toggleRuntimeMcp"
  | "readRuntimeFile"
  | "writeRuntimeFile"
  | "revealRuntimeCredential"
  | "updateRuntimeCredentials"
  | "act"
> &
  RuntimeSkillsApi;

export type RuntimeConfigSection = "access" | "behavior" | "mcp" | "skills" | "prompt" | "advanced";
type Section = RuntimeConfigSection;

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "access", label: "接入" },
  { id: "behavior", label: "行为" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "技能" },
  { id: "prompt", label: "提示词" },
  { id: "advanced", label: "高级" },
];

/** 字段的中文名；键是服务端的字段 id */
const FIELD_LABELS: Record<string, string> = {
  model: "模型",
  fableModel: "Fable 档默认模型",
  opusModel: "Opus 档默认模型",
  sonnetModel: "Sonnet 档默认模型",
  haikuModel: "Haiku 档默认模型",
  subagentModel: "子 Agent 用的模型",
  permissionMode: "默认权限模式",
  model_provider: "使用的 provider",
  wire_api: "接口协议",
  model_reasoning_effort: "推理强度",
  approval_policy: "审批策略",
  sandbox_mode: "沙箱",
  small_model: "小模型",
  toolsProfile: "工具档位",
};

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function RuntimeConfigPanel({
  api,
  provider,
  initialSection = "access",
}: {
  api: RuntimeConfigApi;
  provider: RuntimeCredentialProvider;
  /** 从总览跳过来时直接打开的那一组 */
  initialSection?: RuntimeConfigSection;
}) {
  const [result, setResult] = useState<RuntimeConfigResult>();
  const [section, setSection] = useState<Section>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const [saved, setSaved] = useState(0);
  const [error, setError] = useState<string>();
  const { runtimeConfig } = api;

  const reload = useCallback(() => {
    runtimeConfig(provider).then(setResult, (reason: unknown) => setError(errorMessage(reason)));
  }, [runtimeConfig, provider]);
  useEffect(reload, [reload]);

  /** 任何一项保存成功：换上最新配置，显示要不要重启 */
  const onSaved = useCallback((next?: RuntimeConfigResult) => {
    if (next) setResult(next);
    setSaved((count) => count + 1);
  }, []);

  if (!result) {
    return (
      <div className="runtime-config">
        {error ? (
          <p className="settings-note error">{error}</p>
        ) : (
          <p className="settings-note">{t("正在读取配置…")}</p>
        )}
      </div>
    );
  }
  const { config, agents } = result;
  const label = RUNTIME_LABELS[provider];
  const props = { api, provider, label, config, onSaved };

  return (
    <div className="runtime-config">
      <div className="runtime-config-tabs" role="tablist" aria-label={t("{0} 配置", { 0: label })}>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className={section === item.id ? "active" : ""}
            onClick={() => setSection(item.id)}
          >
            {item.id === "mcp" ? item.label : t(item.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {section === "access" && <AccessSection {...props} />}
        {section === "behavior" && <FieldsSection {...props} group="behavior" />}
        {section === "mcp" && <McpSection {...props} />}
        {section === "skills" && <SkillsSection api={api} provider={provider} />}
        {section === "prompt" && <PromptSection {...props} />}
        {section === "advanced" && <AdvancedSection {...props} />}
      </div>
      {saved > 0 && (
        <RestartNotice
          key={saved}
          api={api}
          provider={provider}
          effect={config.credentials.effect}
          agents={agents}
        />
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

type SectionProps = {
  api: RuntimeConfigApi;
  provider: RuntimeCredentialProvider;
  label: string;
  config: RuntimeConfigResult["config"];
  onSaved: (next?: RuntimeConfigResult) => void;
};

function AccessSection(props: SectionProps) {
  const { api, provider, label, config, onSaved } = props;
  const credentials = config.credentials;
  return (
    <>
      {credentials.configured ? (
        <div className="runtime-config-block">
          <small className="runtime-credentials-files">
            {credentials.providerId
              ? t("当前 provider：{0}", { 0: credentials.providerId })
              : credentials.files.join(t("、"))}
          </small>
          {(["baseUrl", "apiKey"] as const).map((field) => (
            <CredentialRow
              key={field}
              api={api}
              provider={provider}
              runtimeLabel={label}
              field={field}
              info={credentials[field]}
              onSaved={() => {
                void api.runtimeConfig(provider).then(onSaved, () => onSaved());
              }}
            />
          ))}
        </div>
      ) : (
        <p className="settings-note">
          {t("接口地址和密钥：未配置。")}
          {credentials.note}
        </p>
      )}
      <FieldsSection {...props} group="access" />
    </>
  );
}

function FieldsSection({
  api,
  provider,
  label,
  config,
  onSaved,
  group,
}: SectionProps & { group: RuntimeConfigField["group"] }) {
  const fields = config.fields.filter((field) => field.group === group);
  const [draft, setDraft] = useState<Record<string, string | boolean | null>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saveRef = useRef<HTMLButtonElement>(null);
  if (!fields.length) {
    return (
      <p className="settings-note">
        {group === "behavior"
          ? t("这个 CLI 没有可以在这里改的行为设置，需要时到「高级」里直接改配置文件。")
          : null}
      </p>
    );
  }
  const changed = Object.keys(draft).length > 0;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api.updateRuntimeFields(provider, draft));
      setDraft({});
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const change = (field: RuntimeConfigField, value: string | boolean | null) => {
    setDraft((current) => {
      const next = { ...current };
      if (value === field.value) delete next[field.id];
      else next[field.id] = value;
      return next;
    });
  };
  return (
    <div className="runtime-config-block">
      {fields.map((field) => {
        const value = field.id in draft ? draft[field.id]! : field.value;
        const name = t(FIELD_LABELS[field.id] ?? field.id);
        return (
          <label key={field.id} className="runtime-config-field">
            <span>{name}</span>
            {field.kind === "boolean" ? (
              <input
                type="checkbox"
                checked={value === true}
                disabled={!field.editable}
                onChange={(event) => change(field, event.target.checked)}
              />
            ) : field.kind === "select" ? (
              <select
                value={typeof value === "string" ? value : ""}
                disabled={!field.editable}
                onChange={(event) => change(field, event.target.value || null)}
              >
                <option value="">{t("（CLI 默认）")}</option>
                {[
                  ...(field.options ?? []),
                  ...(typeof field.value === "string" && !field.options?.includes(field.value)
                    ? [field.value]
                    : []),
                ].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={typeof value === "string" ? value : ""}
                placeholder={t("（CLI 默认）")}
                disabled={!field.editable}
                onChange={(event) =>
                  change(field, event.target.value.trim() ? event.target.value : null)
                }
              />
            )}
            <small>{field.location}</small>
            {field.note && <small className="runtime-credential-note">{field.note}</small>}
            {field.shadowedBy && (
              <small className="runtime-credential-note">
                {t("被 {0} 覆盖，改这里不生效", { 0: field.shadowedBy })}
              </small>
            )}
          </label>
        );
      })}
      <div className="runtime-config-actions">
        <Button
          ref={saveRef}
          size="sm"
          variant="primary"
          disabled={!changed || busy}
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          {t("保存")}
        </Button>
        {changed && (
          <Button size="sm" onClick={() => setDraft({})}>
            {t("撤销修改")}
          </Button>
        )}
      </div>
      {confirming && (
        <ConfirmPopover
          ariaLabel={t("确认保存 {0} 的配置", { 0: label })}
          title={t("会同时影响终端里的 {0}", { 0: label })}
          message={t(
            "改的是这台电脑上 {0} 的全局配置（原文件先备份）。留空的项会删掉，回到 CLI 默认。",
            {
              0: label,
            },
          )}
          confirmLabel={t("保存")}
          cancelLabel={t("取消")}
          anchorRef={saveRef}
          busy={busy}
          onConfirm={() => void save()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/* ---------- MCP ---------- */

export type McpDraft = {
  previousName?: string;
  name: string;
  transport: RuntimeMcpServer["transport"];
  command: string;
  args: string;
  url: string;
  /** 一行一个 KEY=VALUE；原有变量显示成 KEY=，留空表示沿用原值 */
  env: string;
  existingEnv: string[];
};

export const emptyDraft = (): McpDraft => ({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  existingEnv: [],
});

function draftOf(server: RuntimeMcpServer): McpDraft {
  return {
    previousName: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    url: server.url ?? "",
    env: server.envKeys.map((key) => `${key}=`).join("\n"),
    existingEnv: server.envKeys,
  };
}

/** 表单 → 接口参数；env 里原有变量留空就传 null（沿用原值） */
export function mcpInput(draft: McpDraft, enabled: boolean): RuntimeMcpServerInput {
  const env: Record<string, string | null> = {};
  for (const line of draft.env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim();
    const value = eq < 0 ? "" : trimmed.slice(eq + 1);
    env[key] = !value && draft.existingEnv.includes(key) ? null : value;
  }
  return draft.transport === "stdio"
    ? {
        transport: "stdio",
        command: draft.command.trim(),
        args: draft.args
          .split("\n")
          .map((arg) => arg.trim())
          .filter(Boolean),
        env,
        enabled,
      }
    : { transport: draft.transport, url: draft.url.trim(), env, enabled };
}

function McpSection({ api, provider, label, config, onSaved }: SectionProps) {
  const mcp = config.mcp;
  const [editing, setEditing] = useState<McpDraft>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleteRefs = useRef(new Map<string, HTMLButtonElement | null>());
  if (!mcp.supported) {
    return <p className="settings-note">{mcp.note}</p>;
  }
  const run = async (action: () => Promise<RuntimeConfigResult>) => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await action());
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="runtime-config-block">
      <small className="runtime-credentials-files">{mcp.file}</small>
      {mcp.servers.length === 0 && <p className="settings-note">{t("还没有全局 MCP 服务器。")}</p>}
      <ul className="runtime-mcp-list">
        {mcp.servers.map((server) => (
          <li key={server.name} className={server.enabled ? "" : "disabled"}>
            <div>
              <strong>{server.name}</strong>
              <span className="runtime-credentials-badge">{server.transport}</span>
              {!server.enabled && <span className="runtime-credentials-badge">{t("已停用")}</span>}
              <code>
                {server.transport === "stdio"
                  ? [server.command, ...(server.args ?? [])].join(" ")
                  : server.url}
              </code>
              {server.envKeys.length > 0 && (
                <small>{t("环境变量：{0}", { 0: server.envKeys.join("、") })}</small>
              )}
            </div>
            <div className="runtime-config-actions">
              {mcp.canToggle && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.toggleRuntimeMcp(provider, server.name, !server.enabled))
                  }
                >
                  {server.enabled ? t("停用") : t("启用")}
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => setEditing(draftOf(server))}>
                {t("编辑")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                ref={(element) => {
                  deleteRefs.current.set(server.name, element);
                }}
                disabled={busy}
                aria-expanded={deleting === server.name}
                onClick={() => setDeleting(server.name)}
              >
                {t("删除")}
              </Button>
            </div>
            {deleting === server.name && (
              <ConfirmPopover
                ariaLabel={t("确认删除 MCP {0}", { 0: server.name })}
                message={t("从 {0} 的全局配置里删掉 {1}（原文件先备份）。", {
                  0: label,
                  1: server.name,
                })}
                confirmLabel={t("删除")}
                cancelLabel={t("取消")}
                danger
                busy={busy}
                anchorRef={{ current: deleteRefs.current.get(server.name) ?? null }}
                onConfirm={() =>
                  void run(() => api.deleteRuntimeMcp(provider, server.name)).then(() =>
                    setDeleting(undefined),
                  )
                }
                onCancel={() => setDeleting(undefined)}
              />
            )}
          </li>
        ))}
      </ul>
      {!mcp.canToggle && mcp.servers.length > 0 && (
        <p className="settings-note">
          {t("{0} 的全局配置没有单独停用的开关，不用了就删掉。", { 0: label })}
        </p>
      )}
      {editing ? (
        <McpForm
          draft={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(undefined)}
          onSave={() => {
            const enabled =
              mcp.servers.find((server) => server.name === editing.previousName)?.enabled ?? true;
            void run(() =>
              api.putRuntimeMcp(
                provider,
                editing.name.trim(),
                mcpInput(editing, enabled),
                editing.previousName,
              ),
            ).then((ok) => ok && setEditing(undefined));
          }}
        />
      ) : (
        <Button
          size="sm"
          className="settings-button"
          disabled={busy}
          onClick={() => setEditing(emptyDraft())}
        >
          {t("添加 MCP 服务器")}
        </Button>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

export function McpForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: McpDraft;
  busy: boolean;
  onChange: (draft: McpDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<McpDraft>) => onChange({ ...draft, ...patch });
  const valid =
    /^[A-Za-z0-9_.-]+$/.test(draft.name.trim()) &&
    (draft.transport === "stdio"
      ? Boolean(draft.command.trim())
      : /^https?:\/\/\S+$/.test(draft.url.trim()));
  return (
    <form
      className="runtime-mcp-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave();
      }}
    >
      <label>
        <span>{t("名称")}</span>
        <input value={draft.name} onChange={(event) => set({ name: event.target.value })} />
      </label>
      <label>
        <span>{t("连接方式")}</span>
        <select
          value={draft.transport}
          onChange={(event) =>
            set({ transport: event.target.value as RuntimeMcpServer["transport"] })
          }
        >
          <option value="stdio">{t("本机命令（stdio）")}</option>
          <option value="http">{t("远程地址（HTTP）")}</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      {draft.transport === "stdio" ? (
        <>
          <label>
            <span>{t("命令")}</span>
            <input
              value={draft.command}
              spellCheck={false}
              onChange={(event) => set({ command: event.target.value })}
            />
          </label>
          <label>
            <span>{t("参数（一行一个）")}</span>
            <textarea
              rows={3}
              value={draft.args}
              spellCheck={false}
              onChange={(event) => set({ args: event.target.value })}
            />
          </label>
        </>
      ) : (
        <label>
          <span>URL</span>
          <input
            value={draft.url}
            spellCheck={false}
            placeholder="https://"
            onChange={(event) => set({ url: event.target.value })}
          />
        </label>
      )}
      <label>
        <span>{t("环境变量（一行一个 KEY=VALUE；原有的留空表示不改）")}</span>
        <textarea
          rows={3}
          value={draft.env}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => set({ env: event.target.value })}
        />
      </label>
      <div className="runtime-config-actions">
        <Button type="submit" size="sm" variant="primary" disabled={!valid || busy}>
          {t("保存")}
        </Button>
        <Button size="sm" onClick={onCancel}>
          {t("取消")}
        </Button>
      </div>
    </form>
  );
}

/* ---------- 整份文件：提示词与原始配置 ---------- */

function FileEditor({
  api,
  provider,
  file,
  onSaved,
  onClose,
}: {
  api: RuntimeConfigApi;
  provider: RuntimeCredentialProvider;
  file: RuntimeConfigFile;
  onSaved: (next: RuntimeConfigResult) => void;
  onClose?: () => void;
}) {
  const [loaded, setLoaded] = useState<{ content: string; hash: string | null }>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { readRuntimeFile } = api;
  useEffect(() => {
    readRuntimeFile(provider, file.id).then(
      (value) => {
        setLoaded(value);
        setContent(value.content);
      },
      (reason: unknown) => setError(errorMessage(reason)),
    );
  }, [readRuntimeFile, provider, file.id]);
  const save = async () => {
    if (!loaded) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.writeRuntimeFile(provider, file.id, content, loaded.hash);
      setLoaded({ content, hash: next.hash });
      onSaved(next);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="runtime-file-editor">
      {loaded ? (
        <textarea
          aria-label={t("{0} 的内容", { 0: file.path })}
          value={content}
          spellCheck={false}
          rows={14}
          onChange={(event) => setContent(event.target.value)}
        />
      ) : (
        !error && <p className="settings-note">{t("正在读取…")}</p>
      )}
      <div className="runtime-config-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={!loaded || busy || content === loaded.content}
          onClick={() => void save()}
        >
          {busy ? t("正在保存…") : t("保存")}
        </Button>
        {onClose && (
          <Button size="sm" onClick={onClose}>
            {t("收起")}
          </Button>
        )}
      </div>
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

function PromptSection({ api, provider, config, onSaved }: SectionProps) {
  const prompt = config.prompt;
  if (!prompt) return <p className="settings-note">{t("这个 CLI 没有全局提示词文件。")}</p>;
  return (
    <div className="runtime-config-block">
      <small className="runtime-credentials-files">
        {prompt.exists ? prompt.path : t("{0}（还没有，保存后新建）", { 0: prompt.path })}
      </small>
      <p className="settings-note">
        {t("对这台电脑上这个 CLI 的所有会话生效，包括 Hive 里的 Agent 和终端里的 CLI。")}
      </p>
      <FileEditor api={api} provider={provider} file={prompt} onSaved={onSaved} />
    </div>
  );
}

function AdvancedSection({ api, provider, label, config, onSaved }: SectionProps) {
  const [open, setOpen] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const refs = useRef(new Map<string, HTMLButtonElement | null>());
  return (
    <div className="runtime-config-block">
      <p className="settings-note">
        {t(
          "直接编辑整份配置文件。保存前会检查语法，有错不会写入；打开后文件被别处改过也不会覆盖。",
        )}
      </p>
      {config.rawFiles.map((file) => (
        <div key={file.id} className="runtime-raw-file">
          <div className="runtime-config-actions">
            <code>{file.path}</code>
            {!file.exists && <span className="runtime-credentials-badge">{t("不存在")}</span>}
            {open !== file.id && (
              <Button
                size="sm"
                ref={(element) => {
                  refs.current.set(file.id, element);
                }}
                aria-expanded={confirming === file.id}
                onClick={() => setConfirming(file.id)}
              >
                {t("查看并编辑")}
              </Button>
            )}
          </div>
          {confirming === file.id && (
            <ConfirmPopover
              ariaLabel={t("确认显示 {0}", { 0: file.path })}
              message={t(
                "原文里可能有密钥，会完整显示在这个页面上。确认身边没有别人在看屏幕；改动会影响终端里的 {0}。",
                { 0: label },
              )}
              confirmLabel={t("显示")}
              cancelLabel={t("取消")}
              anchorRef={{ current: refs.current.get(file.id) ?? null }}
              onConfirm={() => {
                setConfirming(undefined);
                setOpen(file.id);
              }}
              onCancel={() => setConfirming(undefined)}
            />
          )}
          {open === file.id && (
            <FileEditor
              api={api}
              provider={provider}
              file={file}
              onSaved={onSaved}
              onClose={() => setOpen(undefined)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

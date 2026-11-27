import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type {
  RuntimeCredentialProvider,
  RuntimeOverview,
  SkillInstallFile,
  SkillInstallPreview,
  SkillInstallResult,
  SkillSearchItem,
} from "@superhive/protocol";
import { Button, IconButton } from "./button";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { RUNTIME_LABELS } from "./runtime-credentials";

/**
 * 「发现 / 安装 → 技能」：在 skills.sh 上搜别人分享的 skill，点开先看再装。
 *
 * - 搜索走 Server 代理 skills.sh（npx skills find 用的同一个接口），结果按安装量排，标出来源仓库和「常用来源」；
 * - 点「查看」时 Server 把这个 skill 下载到内存：抽屉里给出 SKILL.md 原文和文件清单，脚本、可执行、
 *   二进制单独标出来；这一步不写文件、不运行任何东西，SKILL.md 只当文本显示；
 * - 选好装给哪些 CLI 后，Server 写的就是预览里这一份；同名已有的不覆盖，结果每个 CLI 单独报。
 */

export type SkillStoreApi = Pick<
  LocalAgentsState,
  "runtimeOverview" | "searchSkillMarket" | "previewSkillInstall" | "applySkillInstall"
>;

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** 没搜之前给几个常见词，点一下就搜 */
const SUGGESTIONS = ["pdf", "docx", "frontend design", "testing", "react", "git"];

const HUES = [212, 262, 330, 8, 28, 45, 145, 172, 190, 290];
function hue(id: string) {
  let value = 0;
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return HUES[value % HUES.length]!;
}

function SkillIcon({ name, id, large }: { name: string; id: string; large?: boolean }) {
  return (
    <span
      className={`runtime-store-icon${large ? " large" : ""}`}
      style={{ "--store-hue": hue(id) } as CSSProperties}
      aria-hidden="true"
    >
      {(name.replace(/[^A-Za-z0-9]/g, "")[0] ?? name[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** 1234 → 1.2K（和 hive skill search 一样） */
export function installsLabel(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 这个名字的 skill 已经在哪些 CLI 里 */
function installedIn(name: string, overview: RuntimeOverview | undefined) {
  return (
    overview?.skills.find((row) => row.name === name)?.entries.map((item) => item.provider) ?? []
  );
}

export function SkillStore({ api }: { api: SkillStoreApi }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchItem[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [popularOnly, setPopularOnly] = useState(false);
  const [overview, setOverview] = useState<RuntimeOverview>();
  const [open, setOpen] = useState<SkillSearchItem>();
  const { runtimeOverview, searchSkillMarket } = api;
  const seq = useRef(0);
  /** 关上抽屉后焦点回到点开它的「查看」按钮 */
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    runtimeOverview().then(setOverview, () => undefined);
  }, [runtimeOverview]);

  /** 搜 text；输入框不动（防抖调用时它就是当前内容） */
  const run = useCallback(
    (text: string) => {
      const next = text.trim();
      if (next.length < 2) return;
      const id = ++seq.current;
      setQuery(next);
      setLoading(true);
      setError(undefined);
      searchSkillMarket(next).then(
        (response) => {
          if (id !== seq.current) return;
          setResults(response.skills);
          setLoading(false);
        },
        (reason: unknown) => {
          if (id !== seq.current) return;
          setError(errorMessage(reason));
          setLoading(false);
        },
      );
    },
    [searchSkillMarket],
  );
  const search = (text: string) => {
    setInput(text);
    run(text);
  };

  // 停手 400 毫秒再搜，回车立即搜
  useEffect(() => {
    if (input.trim().length < 2 || input.trim() === query) return;
    const timer = setTimeout(() => run(input), 400);
    return () => clearTimeout(timer);
  }, [input, query, run]);

  const shown = useMemo(
    () => (popularOnly ? (results ?? []).filter((item) => item.popular) : (results ?? [])),
    [popularOnly, results],
  );

  return (
    <div className="runtime-store skill-store">
      <form
        className="runtime-store-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search(input);
        }}
      >
        <input
          type="search"
          className="runtime-store-search"
          aria-label={t("搜索技能")}
          placeholder={t("在 skills.sh 上搜，例如：pdf、react、测试")}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <div className="runtime-store-categories" role="group" aria-label={t("筛选")}>
          <button
            type="button"
            aria-pressed={popularOnly}
            onClick={() => setPopularOnly((value) => !value)}
          >
            {t("只看常用来源")}
          </button>
        </div>
      </form>
      {!results && !loading && !error && (
        <div className="skill-store-start">
          <p>{t("搜别人在 GitHub 上分享的技能，点开先看内容再决定装不装。试试：")}</p>
          <div className="skill-store-suggestions">
            {SUGGESTIONS.map((word) => (
              <Button key={word} size="sm" variant="secondary" onClick={() => search(word)}>
                {word}
              </Button>
            ))}
          </div>
        </div>
      )}
      {loading && <p className="runtime-store-empty">{t("正在搜索…")}</p>}
      {error && (
        <p className="settings-note error" role="alert">
          {error}
        </p>
      )}
      {results && !loading && (
        <>
          <p className="skill-store-count" aria-live="polite">
            {shown.length
              ? t("「{0}」找到 {1} 个，按安装量排序", { 0: query, 1: shown.length })
              : popularOnly && results.length
                ? t("常用来源里没有「{0}」，关掉「只看常用来源」看看全部 {1} 个。", {
                    0: query,
                    1: results.length,
                  })
                : t("没有找到「{0}」，换个词试试。", { 0: query })}
          </p>
          {shown.length > 0 && (
            <ul className="skill-store-list" aria-label={t("搜索结果")}>
              {shown.map((item) => {
                const have = installedIn(item.name, overview);
                return (
                  <li key={item.id} className="skill-store-row">
                    <SkillIcon name={item.name} id={item.id} />
                    <div className="skill-store-main">
                      <strong title={item.name}>{item.name}</strong>
                      <small title={item.source}>
                        {item.source}
                        {item.popular && <span className="skill-store-badge">{t("常用来源")}</span>}
                      </small>
                    </div>
                    <span className="skill-store-installs" title={t("安装次数")}>
                      {t("{0} 次安装", { 0: installsLabel(item.installs) })}
                    </span>
                    {have.length > 0 ? (
                      <span className="runtime-store-installed">
                        {t("同名的已装到 {0} 个 CLI", { 0: have.length })}
                      </span>
                    ) : (
                      <span />
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("查看 {0}", { 0: item.id })}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setOpen(item);
                      }}
                    >
                      {t("查看")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <p className="runtime-store-foot">
        {t(
          "搜索结果来自 skills.sh，内容由各仓库作者维护，Hive 没有审核过。装之前先看看 SKILL.md 和里面的脚本。",
        )}
      </p>
      {open && (
        <SkillDrawer
          key={open.id}
          api={api}
          item={open}
          onInstalled={setOverview}
          onClose={() => {
            setOpen(undefined);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<SkillInstallFile["kind"], string> = {
  doc: "文档",
  script: "脚本",
  binary: "二进制",
  other: "",
};

/** 默认勾上：还没有同名的，并且不会被已勾的另一个 CLI 的目录顺带用上 */
export function defaultTargets(preview: SkillInstallPreview): RuntimeCredentialProvider[] {
  const chosen: RuntimeCredentialProvider[] = [];
  for (const target of preview.targets) {
    if (target.exists) continue;
    const covered = chosen.some((provider) =>
      preview.targets
        .find((item) => item.provider === provider)
        ?.sharedWith.includes(target.provider),
    );
    if (!covered) chosen.push(target.provider);
  }
  return chosen;
}

export function SkillDrawer({
  api,
  item,
  onInstalled,
  onClose,
}: {
  api: SkillStoreApi;
  item: SkillSearchItem;
  onInstalled: (overview: RuntimeOverview) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<SkillInstallPreview>();
  const [loadError, setLoadError] = useState<string>();
  const [targets, setTargets] = useState<RuntimeCredentialProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<SkillInstallResult>();
  const panelRef = useRef<HTMLDivElement>(null);
  const { previewSkillInstall } = api;

  const { source, skillId } = item;
  const load = useCallback(() => {
    setLoadError(undefined);
    setPreview(undefined);
    previewSkillInstall(source, skillId).then(
      (next) => {
        setPreview(next);
        setTargets(defaultTargets(next));
      },
      (reason: unknown) => setLoadError(errorMessage(reason)),
    );
  }, [previewSkillInstall, source, skillId]);
  useEffect(load, [load]);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>(".runtime-drawer-close")?.focus();
  }, []);

  const install = async () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.applySkillInstall(preview.id, targets);
      setDone(result);
      onInstalled(result.overview);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const scripts = preview?.files.filter((file) => file.kind === "script" || file.kind === "binary");
  const labelOf = (provider: RuntimeCredentialProvider) => RUNTIME_LABELS[provider];
  const available = preview?.targets.filter((target) => !target.exists) ?? [];
  const existing = preview?.targets.filter((target) => target.exists) ?? [];
  const expired = preview ? preview.expiresAt <= Date.now() : false;

  return (
    <div className="runtime-drawer-layer">
      <button
        type="button"
        className="runtime-drawer-scrim"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="runtime-drawer wide"
        role="dialog"
        aria-modal="true"
        aria-label={t("技能 {0}", { 0: item.name })}
        onKeyDown={handleKeyDown}
      >
        <header className="runtime-drawer-head">
          <SkillIcon name={item.name} id={item.id} large />
          <div>
            <h3>{preview?.name ?? item.name}</h3>
            <small>
              {item.source} · {t("{0} 次安装", { 0: installsLabel(item.installs) })}
            </small>
          </div>
          <IconButton className="runtime-drawer-close" label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </IconButton>
        </header>
        <div className="runtime-drawer-body">
          {!preview && !loadError && (
            <p className="runtime-drawer-nothing">{t("正在从 GitHub 下载，先给你看看内容…")}</p>
          )}
          {loadError && (
            <div className="runtime-drawer-failed" role="alert">
              <strong>{t("没能打开")}</strong>
              <p>{loadError}</p>
              <Button size="sm" onClick={load}>
                {t("重试")}
              </Button>
            </div>
          )}
          {preview && !done && (
            <>
              {preview.description && <p className="runtime-drawer-desc">{preview.description}</p>}
              <p className={`skill-drawer-origin${preview.verified ? "" : " warn"}`}>
                {preview.verified
                  ? t("来自 {0} 的提交 {1}，每个文件都和 GitHub 核对过。", {
                      0: preview.source,
                      1: preview.commit!.slice(0, 7),
                    })
                  : t(
                      "GitHub 暂时连不上，内容来自 skills.sh 的缓存，没有和 GitHub 核对。介意的话稍后再打开一次。",
                    )}{" "}
                <a href={preview.url} target="_blank" rel="noreferrer noopener">
                  {t("在 GitHub 上看 ↗")}
                </a>
              </p>
              <section className="skill-drawer-section">
                <h4>{t("装到哪些 CLI")}</h4>
                {preview.targets.length === 0 ? (
                  <p className="runtime-drawer-nothing">{t("这台电脑上还没找到装好的 CLI。")}</p>
                ) : (
                  <>
                    {available.length > 0 && (
                      <div
                        className="runtime-drawer-targets"
                        role="group"
                        aria-label={t("装到哪些 CLI")}
                      >
                        {available.map((target) => (
                          <button
                            key={target.provider}
                            type="button"
                            role="switch"
                            aria-checked={targets.includes(target.provider)}
                            onClick={() =>
                              setTargets((current) =>
                                current.includes(target.provider)
                                  ? current.filter((provider) => provider !== target.provider)
                                  : [...current, target.provider],
                              )
                            }
                          >
                            {labelOf(target.provider)}
                          </button>
                        ))}
                      </div>
                    )}
                    <ul className="skill-drawer-targets-note">
                      {available
                        .filter((target) => targets.includes(target.provider))
                        .map((target) => (
                          <li key={target.provider}>
                            {target.sharedWith.length
                              ? t("{0}：放进 {1}，{2} 也会读到", {
                                  0: labelOf(target.provider),
                                  1: target.path,
                                  2: target.sharedWith.map(labelOf).join("、"),
                                })
                              : t("{0}：放进 {1}", {
                                  0: labelOf(target.provider),
                                  1: target.path,
                                })}
                          </li>
                        ))}
                      {available
                        .filter((target) => !targets.includes(target.provider))
                        .map((target) => {
                          const via = available.find(
                            (other) =>
                              targets.includes(other.provider) &&
                              other.sharedWith.includes(target.provider),
                          );
                          return via ? (
                            <li key={target.provider} className="muted">
                              {t("{0}：会读 {1} 的目录，不用再装一份", {
                                0: labelOf(target.provider),
                                1: labelOf(via.provider),
                              })}
                            </li>
                          ) : null;
                        })}
                      {existing.map((target) => (
                        <li key={target.provider} className="muted">
                          {t("{0} 里已经有同名的 {1}，不会覆盖", {
                            0: labelOf(target.provider),
                            1: preview.name,
                          })}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <section className="skill-drawer-section">
                <h4>
                  {t("文件（{0} 个，共 {1}）", {
                    0: preview.files.length,
                    1: sizeLabel(preview.totalBytes),
                  })}
                </h4>
                {scripts && scripts.length > 0 && (
                  <p className="skill-drawer-warn">
                    {t(
                      "含 {0} 个脚本或程序。现在不会运行；装上以后，Agent 按 SKILL.md 的说明可能会运行它们。",
                      { 0: scripts.length },
                    )}
                  </p>
                )}
                <ul className="skill-drawer-files">
                  {preview.files.map((file) => (
                    <li key={file.path} className={file.kind}>
                      <code>{file.path}</code>
                      <span className="skill-drawer-tags">
                        {KIND_LABEL[file.kind] && file.kind !== "doc" && (
                          <em className={file.kind}>{t(KIND_LABEL[file.kind])}</em>
                        )}
                        {file.executable && <em className="script">{t("可执行")}</em>}
                        <small>{sizeLabel(file.size)}</small>
                      </span>
                    </li>
                  ))}
                  {preview.skipped.map((file) => (
                    <li key={file.path} className="skipped">
                      <code>{file.path}</code>
                      <span className="skill-drawer-tags">
                        <small>
                          {file.reason === "symlink"
                            ? t("软链，不装")
                            : file.reason === "submodule"
                              ? t("子模块，不装")
                              : t("不需要，不装")}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <details className="skill-drawer-section skill-drawer-md" open>
                <summary>SKILL.md</summary>
                <pre tabIndex={0} aria-label="SKILL.md">
                  {preview.skillMd}
                </pre>
              </details>
            </>
          )}
          {done && <SkillInstallDone result={done} name={preview?.name ?? item.name} />}
          {error && (
            <p className="runtime-drawer-error" role="alert">
              {t("没装上：{0}", { 0: error })}
            </p>
          )}
        </div>
        <footer className="runtime-drawer-foot">
          {done ? (
            <Button variant="primary" onClick={onClose}>
              {t("完成")}
            </Button>
          ) : (
            <>
              {expired && (
                <p className="runtime-drawer-note">{t("打开超过 10 分钟了，重新打开后再装。")}</p>
              )}
              <Button
                variant="primary"
                disabled={!preview || busy || targets.length === 0 || expired}
                loading={busy}
                onClick={() => void install()}
              >
                {t("安装")}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function SkillInstallDone({ result, name }: { result: SkillInstallResult; name: string }) {
  const ok = result.results.filter(
    (item) => item.status === "installed" || item.status === "shared",
  );
  const notOk = result.results.filter(
    (item) => item.status === "exists" || item.status === "failed",
  );
  return (
    <div className="runtime-drawer-done" role="status">
      {ok.length > 0 && (
        <div className="runtime-drawer-success">
          <strong>
            {t("{0} 装好了：{1}", {
              0: name,
              1: ok.map((item) => RUNTIME_LABELS[item.provider]).join("、"),
            })}
          </strong>
          <ul className="skill-drawer-results">
            {ok.map((item) => (
              <li key={item.provider}>
                {item.status === "installed"
                  ? t("{0}：{1}", { 0: RUNTIME_LABELS[item.provider], 1: item.path ?? "" })
                  : t("{0}：{1}", { 0: RUNTIME_LABELS[item.provider], 1: item.error ?? "" })}
              </li>
            ))}
          </ul>
          <p>
            {t(
              "新开的会话就能用；正在运行的 Agent 要重启后才看得到。可以在「已安装 → 技能」里开关。",
            )}
          </p>
        </div>
      )}
      {notOk.map((item) => (
        <div key={item.provider} className="runtime-drawer-failed">
          <strong>
            {item.status === "exists"
              ? t("{0} 没有装", { 0: RUNTIME_LABELS[item.provider] })
              : t("{0} 没装上", { 0: RUNTIME_LABELS[item.provider] })}
          </strong>
          <p>{item.error ?? t("原因不明")}</p>
        </div>
      ))}
    </div>
  );
}

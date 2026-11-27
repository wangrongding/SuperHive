import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  RuntimeCredentialProvider,
  RuntimeProfile,
  RuntimeProfiles,
} from "@superhive/protocol";
import { Button, IconButton } from "./button";
import { ConfirmPopover } from "./confirm-popover";
import { ContextMenu } from "./context-menu";
import { Icon } from "./app-icons";
import { t } from "./i18n";
import type { LocalAgentsState, RuntimeConfigResult, RuntimeProfilesResult } from "./local-agents";

/**
 * 「接入」里的供应商：每个运行时存多套「接口地址 + key」，Claude Code、Codex 另有「官方订阅」（账号登录），
 * 一键切换。切换只改 CLI 自己的配置（先备份），生效规则和下面的地址、key 一样。
 * 存的 key 在 Server 里加密，这里只有打码后的值；cc-switch 存的供应商只读列出，可以导入。
 */

export type RuntimeProfilesApi = Pick<
  LocalAgentsState,
  | "runtimeProfiles"
  | "createRuntimeProfile"
  | "updateRuntimeProfile"
  | "deleteRuntimeProfile"
  | "switchRuntimeProfile"
  | "importCcSwitchProviders"
  | "openRuntimeLogin"
>;

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const OFFICIAL = "official";
const validUrl = (value: string) => /^https?:\/\/\S+$/.test(value.trim());
const validKey = (value: string) => /^[\x21-\x7e]+$/.test(value.trim());

type Draft = { id?: string; name: string; baseUrl: string; apiKey: string };

export function ProfilesSection({
  api,
  provider,
  label,
  file,
  revision,
  onSaved,
}: {
  api: RuntimeProfilesApi;
  provider: RuntimeCredentialProvider;
  label: string;
  /** 切换时改写的配置文件（给确认提示用） */
  file: string;
  /** 变了就重新读（CLI 的地址或 key 在别处改过） */
  revision?: string;
  /** 切换成功：换上最新配置，显示要不要重启 */
  onSaved: (next: RuntimeConfigResult) => void;
}) {
  const [data, setData] = useState<RuntimeProfiles>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  /** 行尾「⋯」菜单（编辑、删除）开在哪一行 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const menuWasOpen = useRef(false);
  const [draft, setDraft] = useState<Draft>();
  const [importing, setImporting] = useState<string[]>();
  const anchors = useRef(new Map<string, HTMLButtonElement | null>());
  const { runtimeProfiles } = api;

  const load = useCallback(() => {
    runtimeProfiles(provider).then(
      (result) => setData(result.profiles),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  }, [runtimeProfiles, provider]);
  useEffect(load, [load, revision]);

  const run = async (action: () => Promise<RuntimeProfilesResult>, switched = false) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      setData(result.profiles);
      if (result.saved) {
        setNotice(t("原来的配置已存为「{0}」，随时可以切回。", { 0: result.saved }));
      } else if (result.imported !== undefined) {
        setNotice(t("导入了 {0} 套。", { 0: result.imported }));
      }
      if (switched) onSaved(result);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return error ? <p className="settings-note error">{error}</p> : null;
  }
  const official = data.official;
  const anchor = (key: string) => ({ current: anchors.current.get(key) ?? null });
  const ref = (key: string) => (element: HTMLButtonElement | null) => {
    anchors.current.set(key, element);
  };
  const target = (key: string) =>
    key === OFFICIAL ? t("官方订阅") : (data.profiles.find((item) => item.id === key)?.name ?? "");
  const switchMessage = (key: string) => {
    const parts = [
      t("将改写 {0}（原文件先备份），终端里的 {1} 也会一起切换。", { 0: file, 1: label }),
    ];
    if (data.unsaved) parts.push(t("现在的地址和 key 会先存成一套。"));
    if (key === OFFICIAL && official?.login !== "yes") {
      parts.push(t("还没登录，切过去后要在终端运行 {0}。", { 0: official?.loginCommand ?? "" }));
    }
    return parts.join("");
  };
  const ccSwitch = data.ccSwitch;
  const importable = ccSwitch?.providers.filter((item) => !item.imported) ?? [];

  const row = (key: string, active: boolean, body: ReactNode, profile?: RuntimeProfile) => (
    <li key={key} className={active ? "active" : ""}>
      <div>{body}</div>
      <div className="runtime-config-actions">
        {active ? (
          <span className="runtime-credentials-badge current">{t("当前")}</span>
        ) : (
          <Button
            size="sm"
            ref={ref(`switch:${key}`)}
            disabled={busy || Boolean(data.note)}
            aria-expanded={confirming === key}
            onClick={() => setConfirming(key)}
          >
            {t("切换")}
          </Button>
        )}
        {profile && (
          <IconButton
            size="sm"
            variant="secondary"
            ref={ref(`more:${key}`)}
            label={t("{0} 的更多操作", { 0: profile.name })}
            tooltip={false}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menu?.id === key}
            onPointerDown={() => {
              menuWasOpen.current = menu?.id === key;
            }}
            onClick={(event) => {
              // 菜单开着时按下按钮：pointerdown 在外面先把菜单关了，这一下只是关，不再打开
              if (menuWasOpen.current || menu?.id === key) {
                menuWasOpen.current = false;
                setMenu(undefined);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ id: key, x: rect.right, y: rect.bottom + 4 });
            }}
          >
            <Icon name="more" size={16} />
          </IconButton>
        )}
      </div>
      {confirming === key && (
        <ConfirmPopover
          ariaLabel={t("确认切换到 {0}", { 0: target(key) })}
          title={t("切换到「{0}」", { 0: target(key) })}
          message={switchMessage(key)}
          confirmLabel={t("切换")}
          cancelLabel={t("取消")}
          anchorRef={anchor(`switch:${key}`)}
          busy={busy}
          onConfirm={() =>
            void run(
              () =>
                api.switchRuntimeProfile(
                  provider,
                  key === OFFICIAL ? { official: true } : { profileId: key },
                ),
              true,
            ).then(() => setConfirming(undefined))
          }
          onCancel={() => setConfirming(undefined)}
        />
      )}
      {menu?.id === key && profile && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            align: "end",
            items: [
              {
                label: t("编辑"),
                onSelect: () =>
                  setDraft({ id: profile.id, name: profile.name, baseUrl: "", apiKey: "" }),
              },
              // 红色只留给确认那一步
              { label: t("删除"), onSelect: () => setDeleting(key) },
            ],
          }}
          onClose={() => setMenu(undefined)}
        />
      )}
      {deleting === key && profile && (
        <ConfirmPopover
          ariaLabel={t("确认删除 {0}", { 0: profile.name })}
          message={t("只删这里存的这一套，不改 {0} 的配置。", { 0: label })}
          confirmLabel={t("删除")}
          cancelLabel={t("取消")}
          danger
          busy={busy}
          anchorRef={anchor(`more:${key}`)}
          onConfirm={() =>
            void run(() => api.deleteRuntimeProfile(provider, profile.id)).then(() =>
              setDeleting(undefined),
            )
          }
          onCancel={() => setDeleting(undefined)}
        />
      )}
    </li>
  );

  const editing = draft?.id ? data.profiles.find((item) => item.id === draft.id) : undefined;
  const draftValid = draft
    ? Boolean(draft.name.trim()) &&
      (editing
        ? (!draft.baseUrl.trim() || validUrl(draft.baseUrl)) &&
          (!draft.apiKey.trim() || validKey(draft.apiKey))
        : validUrl(draft.baseUrl) && validKey(draft.apiKey))
    : false;
  const saveDraft = () => {
    if (!draft || !draftValid) return;
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    const apiKey = draft.apiKey.trim();
    const patch = {
      ...(name !== editing?.name ? { name } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    if (draft.id && !Object.keys(patch).length) {
      setDraft(undefined);
      return;
    }
    void run(() =>
      draft.id
        ? api.updateRuntimeProfile(provider, draft.id, patch)
        : api.createRuntimeProfile(provider, { name, baseUrl, apiKey }),
    ).then((ok) => ok && setDraft(undefined));
  };

  return (
    <div className="runtime-config-block runtime-profiles">
      <div className="runtime-profiles-head">
        <strong>{t("供应商")}</strong>
        {!draft && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setDraft({ name: "", baseUrl: "", apiKey: "" })}
          >
            {t("添加")}
          </Button>
        )}
      </div>
      {data.note && <p className="settings-note warning">{data.note}</p>}
      <ul className="runtime-mcp-list runtime-profile-list">
        {official &&
          row(
            OFFICIAL,
            official.active,
            <>
              <strong>{t("官方订阅")}</strong>
              <span
                className={`runtime-credentials-badge ${official.login === "no" ? "warn" : ""}`}
              >
                {official.login === "yes"
                  ? t("已登录")
                  : official.login === "no"
                    ? t("未登录")
                    : t("登录状态未知")}
              </span>
              <small>
                {official.login === "yes"
                  ? t("用账号登录，不用地址和 key")
                  : t("在终端运行 {0} 登录", { 0: official.loginCommand })}
                {official.login !== "yes" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="runtime-profile-login"
                    disabled={busy}
                    onClick={() => {
                      setError(undefined);
                      api.openRuntimeLogin(provider).then(
                        () => setNotice(t("已打开终端，登录完成后回来刷新。")),
                        (reason: unknown) => setError(errorMessage(reason)),
                      );
                    }}
                  >
                    {t("在终端登录")}
                  </Button>
                )}
              </small>
              {official.active && official.leftover.length > 0 && (
                <small className="runtime-credential-note">
                  {t("仍在生效，官方不一定认：{0}", { 0: official.leftover.join(t("、")) })}
                </small>
              )}
            </>,
          )}
        {data.profiles.map((profile) =>
          row(
            profile.id,
            profile.active,
            <>
              <strong>{profile.name}</strong>
              {profile.source !== "hive" && (
                <span className="runtime-credentials-badge">
                  {profile.source === "cc-switch" ? t("来自 cc-switch") : t("原配置")}
                </span>
              )}
              <code>
                {profile.baseUrl} · {profile.apiKey}
              </code>
            </>,
            profile,
          ),
        )}
      </ul>
      {data.unsaved && (
        <p className="settings-note">{t("现在的地址和 key 还没存，切换前会自动存下。")}</p>
      )}
      {draft && (
        <form
          className="runtime-mcp-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveDraft();
          }}
        >
          <label>
            {t("名称")}
            <input
              value={draft.name}
              maxLength={60}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            {t("接口地址（base URL）")}
            <input
              type="url"
              value={draft.baseUrl}
              placeholder={editing ? (editing.baseUrl ?? "") : "https://"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={draft.apiKey}
              placeholder={editing ? t("不改就留空") : ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>
          <div className="runtime-config-actions">
            <Button size="sm" onClick={() => setDraft(undefined)}>
              {t("取消")}
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={!draftValid || busy}>
              {t("保存")}
            </Button>
          </div>
        </form>
      )}
      {ccSwitch && (
        <div className="runtime-profiles-ccswitch" role="note">
          <p>
            {ccSwitch.current
              ? t(
                  "cc-switch 也在管 {0}，它记的当前供应商是「{1}」。这里切换后它不会跟着变；之后要在 cc-switch 里切换，先在这里切回「{2}」，否则 cc-switch 会把这里的地址和 key 存进「{1}」。",
                  { 0: label, 1: ccSwitch.current, 2: ccSwitch.currentProfile ?? ccSwitch.current },
                )
              : t("cc-switch 也在管 {0}，这里切换后 cc-switch 里显示的当前供应商不会跟着变。", {
                  0: label,
                })}
          </p>
          {importable.length > 0 &&
            (importing ? (
              <div className="runtime-profiles-import">
                {importable.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={importing.includes(item.id)}
                      onChange={(event) =>
                        setImporting(
                          event.target.checked
                            ? [...importing, item.id]
                            : importing.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>{item.name}</span>
                    <code>
                      {item.baseUrl} · {item.apiKey}
                    </code>
                  </label>
                ))}
                <div className="runtime-config-actions">
                  <Button size="sm" onClick={() => setImporting(undefined)}>
                    {t("取消")}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || importing.length === 0}
                    onClick={() =>
                      void run(() => api.importCcSwitchProviders(provider, importing)).then(
                        (ok) => ok && setImporting(undefined),
                      )
                    }
                  >
                    {t("导入 {0} 套", { 0: importing.length })}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setImporting(importable.map((item) => item.id))}
              >
                {t("从 cc-switch 导入（{0}）", { 0: importable.length })}
              </Button>
            ))}
        </div>
      )}
      {notice && (
        <p className="settings-note" role="status">
          {notice}
        </p>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { LoginShowcase } from "./login-showcase";
import { t } from "./i18n";
import { storedUsernameKey } from "./app-storage";
import { Icon, HiveLogo } from "./app-icons";
import { Button } from "./button";

/** 点了「进入」之后如果还停在登录页（进入失败、被拦回来），过这么久按钮恢复可点 */
export const LOGIN_BUSY_RESET_MS = 4_000;

export function LoginDialog({
  reduceMotion,
  onJoin,
}: {
  reduceMotion: boolean;
  onJoin: (username: string) => void;
}) {
  const [username, setUsername] = useState(localStorage.getItem(storedUsernameKey) ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    // 记住的名字整段选中，直接回车进入，想换名字也能直接打
    input.select();
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setBusy(false), LOGIN_BUSY_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);
  return (
    <div className="login-shell">
      <main className="login-card">
        <section className="login-intro">
          <div className="login-brand">
            <HiveLogo />
            <strong>SuperHive</strong>
          </div>
          <div className="login-thesis">
            <h1>
              {t("让人类与 Agent，")}
              <span>{t("沿着同一条思路工作。")}</span>
            </h1>
            <p>{t("把消息、协作者与本地 Agent 放进一个实时工作区，所有人都看见同一份上下文。")}</p>
          </div>
          <LoginShowcase still={reduceMotion} />
          <ul className="login-points" aria-label={t("SuperHive 能做什么")}>
            <li>
              <Icon name="at" size={15} />
              <span>{t("@ 一下，Agent 就接活")}</span>
            </li>
            <li>
              <Icon name="activity" size={15} />
              <span>{t("进度、提问、交付都在对话里")}</span>
            </li>
            <li>
              <Icon name="files" size={15} />
              <span>{t("交付附带文件和提交")}</span>
            </li>
          </ul>
        </section>

        <section className="login-form-panel">
          <div className="login-form-body">
            <div className="login-form-heading">
              <span className="login-form-mark">
                <HiveLogo />
              </span>
              <h2>{t("进入 SuperHive")}</h2>
              <p className="login-copy">{t("选择一个在当前房间中可识别的名字。")}</p>
            </div>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                const input = inputRef.current;
                const clean = username.trim();
                if (!clean) {
                  setError(t("先输入一个名字。"));
                  input?.focus();
                  return;
                }
                if (input?.validity.patternMismatch) {
                  setError(t("只能用中英文、数字、点、下划线与连字符。"));
                  input.focus();
                  return;
                }
                setBusy(true);
                try {
                  onJoin(clean);
                } catch {
                  setBusy(false);
                  setError(t("没能进入，请再试一次。"));
                }
              }}
            >
              <label htmlFor="username">{t("你的用户名")}</label>
              <div className={`login-field ${error ? "invalid" : ""}`}>
                <Icon name="user" size={17} />
                <input
                  ref={inputRef}
                  id="username"
                  name="username"
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setError(undefined);
                  }}
                  maxLength={32}
                  pattern="[A-Za-z0-9_.\-\u4e00-\u9fff]+"
                  placeholder={t("例如 rongding…")}
                  autoComplete="username"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="username-hint"
                />
              </div>
              <p
                id="username-hint"
                className={`fine-print ${error ? "error" : ""}`}
                role={error ? "alert" : undefined}
              >
                {error ?? t("支持中英文、数字、点、下划线与连字符。")}
              </p>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                className="login-submit"
                loading={busy}
              >
                <span>{busy ? t("正在进入…") : t("进入聊天室")}</span>
                <Icon name="arrow-right" />
              </Button>
            </form>
            <p className="login-next">
              <Icon name="plug" size={15} />
              <span>
                {t(
                  "进去后点右下角「接入 Agent」，把本机装好的 Claude Code、Codex CLI 等命令行 Agent 拉进房间。",
                )}
              </span>
            </p>
          </div>
          <div className="login-trust">
            <Icon name="shield" size={16} />
            <span>{t("仅在局域网内共享，Agent 权限留在本机。")}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

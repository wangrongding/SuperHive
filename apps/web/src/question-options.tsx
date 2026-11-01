import { useState } from "react";
import type { QuestionAnswer, QuestionSpec } from "@superhive/protocol";
import { t } from "./i18n";

/**
 * Agent 提问的选项：单选点一下即提交，多选勾选后统一提交；最后一行固定是「其它」自由输入。
 * 只在提问仍在等回答时可操作；答完锁住并高亮所选。正文由服务端按题目生成，这里只交所选。
 */
export function QuestionOptions({
  spec,
  waiting,
  pending,
  answer,
  onSubmit,
}: {
  spec: QuestionSpec;
  /** 提问对应的调用仍在等人回答 */
  waiting: boolean;
  /** 已提交、等服务端确认 */
  pending: boolean;
  /** 已经点选提交的答案（用来高亮）；手打回答的没有 */
  answer?: QuestionAnswer;
  onSubmit: (selected: string[], other?: string) => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [other, setOther] = useState("");
  const editable = waiting && !pending && !answer;
  const chosen = new Set(answer?.selected ?? []);
  const otherText = other.trim();

  const toggle = (key: string) => {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  };
  const submitMultiple = () => {
    const selected = spec.options.map((option) => option.key).filter((key) => checked.has(key));
    if (selected.length === 0 && !(otherOpen && otherText)) return;
    onSubmit(selected, otherOpen && otherText ? otherText : undefined);
  };

  return (
    <div
      className={`question-options ${editable ? "" : "locked"}`}
      role="group"
      aria-label={spec.multiple ? t("多选题") : t("单选题")}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="question-options-mode">{spec.multiple ? t("可多选") : t("单选")}</span>
      {spec.options.map((option) => {
        const picked = answer ? chosen.has(option.key) : checked.has(option.key);
        return spec.multiple ? (
          <label key={option.key} className={`question-option ${picked ? "picked" : ""}`}>
            <input
              type="checkbox"
              checked={picked}
              disabled={!editable}
              onChange={() => toggle(option.key)}
            />
            <b>{option.key}</b>
            <span>{option.label}</span>
          </label>
        ) : (
          <button
            key={option.key}
            type="button"
            className={`question-option ${picked ? "picked" : ""}`}
            disabled={!editable}
            aria-pressed={picked}
            onClick={() => onSubmit([option.key])}
          >
            <b>{option.key}</b>
            <span>{option.label}</span>
          </button>
        );
      })}
      {answer?.other ? (
        <div className="question-option picked other">
          <b>{t("其它")}</b>
          <span>{answer.other}</span>
        </div>
      ) : (
        editable && (
          <div className={`question-option other ${otherOpen ? "open" : ""}`}>
            {spec.multiple ? (
              <label>
                <input
                  type="checkbox"
                  checked={otherOpen}
                  onChange={() => setOtherOpen((open) => !open)}
                />
                <b>{t("其它")}</b>
              </label>
            ) : (
              <button
                type="button"
                className="question-other-toggle"
                aria-expanded={otherOpen}
                onClick={() => setOtherOpen((open) => !open)}
              >
                <b>{t("其它")}</b>
              </button>
            )}
            {otherOpen ? (
              <input
                type="text"
                className="question-other-input"
                value={other}
                placeholder={t("输入选项之外的回答…")}
                aria-label={t("其它回答")}
                autoFocus
                onChange={(event) => setOther(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (spec.multiple) submitMultiple();
                  else if (otherText) onSubmit([], otherText);
                }}
              />
            ) : (
              <span className="question-other-hint">{t("都不合适？点这里自己写")}</span>
            )}
            {!spec.multiple && otherOpen && (
              <button
                type="button"
                className="question-submit"
                disabled={!otherText}
                onClick={() => onSubmit([], otherText)}
              >
                {t("提交")}
              </button>
            )}
          </div>
        )
      )}
      {spec.multiple && editable && (
        <button
          type="button"
          className="question-submit"
          disabled={checked.size === 0 && !(otherOpen && otherText)}
          onClick={submitMultiple}
        >
          {t("提交回答")}
        </button>
      )}
      {pending && <span className="question-options-note">{t("正在提交…")}</span>}
      {!waiting && !answer && !pending && (
        <span className="question-options-note">{t("已通过文字回答或已停止等待")}</span>
      )}
    </div>
  );
}

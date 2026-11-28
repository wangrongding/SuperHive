import { agentAccessOptions, type AgentAccessMode } from "./agent-setup";
import { noSandboxNote, workspaceLacksSandbox } from "./member-sandbox";
import { moveRadioSelection } from "./ui-utils";

/**
 * 只读 / 工作区 / 完全访问三档单选：「接入 Agent」第 2 步和 Agent 设置里共用，
 * 文案、顺序、「推荐」都来自 agentAccessOptions，两处保持一致
 */
export function AccessSelector({
  value,
  onChange,
  provider,
  hostPlatform,
  labelledBy,
  disabled = false,
  className,
}: {
  value: AgentAccessMode;
  onChange: (access: AgentAccessMode) => void;
  provider: string;
  /** Agent 跑在 Server 所在电脑上，按它的平台说明（不看浏览器平台） */
  hostPlatform: string | undefined;
  labelledBy: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={className ? `access-selector ${className}` : "access-selector"}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={(event) => {
        if (disabled) return;
        moveRadioSelection(
          event,
          agentAccessOptions.findIndex((option) => option.id === value),
          (index) => onChange(agentAccessOptions[index]!.id),
        );
      }}
    >
      {agentAccessOptions.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.id}
          tabIndex={value === option.id ? 0 : -1}
          className={`${option.id} ${value === option.id ? "active" : ""}`}
          disabled={disabled}
          // 只选中，不自动跳步、不自动保存
          onClick={() => onChange(option.id)}
          key={option.id}
        >
          <span className="access-indicator" aria-hidden="true">
            <i />
          </span>
          <strong>{option.label}</strong>
          <small>{option.description}</small>
          {workspaceLacksSandbox(provider, option.id, hostPlatform) && (
            <small className="access-platform-note">{noSandboxNote()}</small>
          )}
        </button>
      ))}
    </div>
  );
}

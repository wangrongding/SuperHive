/** 设置页里的一行开关：左边标题和说明，右边拨动开关 */
export function SettingsSwitch({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="settings-switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <i className="switch-control" aria-hidden="true">
        <b />
      </i>
    </button>
  );
}

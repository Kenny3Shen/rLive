import { useId, type ReactNode } from "react";

import { Field, FieldContent, FieldTitle } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

import { FieldTip } from "./FieldTip";

type SwitchFieldProps = {
  /** 行标题，渲染为带 id 的 span，供开关 aria-labelledby 引用。 */
  title: ReactNode;
  /** 标题旁的说明图标文案。 */
  tip?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 禁用开关本体。 */
  disabled?: boolean;
  /** 让整行进入 data-disabled 视觉态；与 disabled 独立（如加载中只禁用开关、不变暗标题）。 */
  fieldDisabled?: boolean;
  /** 透传给 Switch 的 className。 */
  className?: string;
  /** 透传给 Field 的 className。 */
  fieldClassName?: string;
};

/** 设置页的开关行：标题 + 说明 + 横排开关，id 与 aria-labelledby 自动配对。 */
function SwitchField({
  title,
  tip,
  checked,
  onCheckedChange,
  disabled = false,
  fieldDisabled,
  className,
  fieldClassName,
}: SwitchFieldProps) {
  const labelId = useId();
  return (
    <Field
      orientation="horizontal"
      data-disabled={fieldDisabled || undefined}
      className={fieldClassName}
    >
      <FieldContent>
        <FieldTitle>
          <span id={labelId}>{title}</span>
          {tip && <FieldTip>{tip}</FieldTip>}
        </FieldTitle>
      </FieldContent>
      <Switch
        aria-labelledby={labelId}
        className={className}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}

export { SwitchField };

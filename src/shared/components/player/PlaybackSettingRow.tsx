import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export function PlaybackSettingRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Field orientation="horizontal" className="min-h-9 px-2.5 py-1.5">
      <FieldLabel htmlFor={id} className="text-sm font-normal">
        {label}
      </FieldLabel>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={() => onToggle()} />
    </Field>
  );
}

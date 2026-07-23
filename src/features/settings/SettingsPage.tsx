import type { ThemeMode } from "../../shared/stores/settingsStore";
import { useSettingsStore } from "../../shared/stores/settingsStore";

const themes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Theme
        </h2>
        <div className="flex flex-wrap gap-2">
          {themes.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={
                theme === value
                  ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

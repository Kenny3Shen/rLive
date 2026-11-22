import { createContext, useContext, type ReactNode } from "react";

import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";

type SettingsLayout = "page" | "sidebar";
export type SettingsFieldOrientation = "horizontal" | "responsive";

const SettingsLayoutContext = createContext<SettingsLayout>("page");

export function SettingsLayoutProvider({
  layout,
  children,
}: {
  layout: SettingsLayout;
  children: ReactNode;
}) {
  return <SettingsLayoutContext.Provider value={layout}>{children}</SettingsLayoutContext.Provider>;
}

/** 设置页按容器宽度响应；播放侧栏固定单行。 */
export function useSettingsFieldOrientation(): SettingsFieldOrientation {
  return useContext(SettingsLayoutContext) === "sidebar" ? "horizontal" : "responsive";
}

/** 设置页与播放侧栏共用的分区表面。 */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const layout = useContext(SettingsLayoutContext);

  return (
    <section
      data-slot="settings-section"
      data-settings-layout={layout}
      className="settings-section overflow-hidden rounded-xl border border-border/80 bg-card/80 shadow-sm shadow-black/10"
    >
      <FieldSet className="gap-0 py-0">
        <div className="settings-section-heading border-b border-border-subtle bg-muted/20 px-4 py-2.5">
          <FieldLegend variant="label" className="m-0 text-sm font-semibold text-foreground">
            {title}
          </FieldLegend>
        </div>
        <FieldGroup className="gap-0 [&>[data-slot=field]]:px-4 [&>[data-slot=field]]:py-3">
          {children}
        </FieldGroup>
      </FieldSet>
    </section>
  );
}

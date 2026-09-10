import "../styles/theme.css";
import { StatusAnnouncer as StatusAnnouncerPrimitive } from "@videojs/react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";

export type StatusAnnouncerProps = Omit<StatusAnnouncerPrimitive.Props, "children">;

export function StatusAnnouncer({ className, ...props }: StatusAnnouncerProps = {}) {
  return (
    <StatusAnnouncerPrimitive
      className={(state) => cn("sr-only", resolveClassName(className, state))}
      {...props}
    />
  );
}

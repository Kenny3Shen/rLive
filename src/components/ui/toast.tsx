import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

/**
 * A single app-level manager keeps command feedback available to mutations
 * initiated from any route, including context menus and portalled controls.
 */
export const toast = ToastPrimitive.createToastManager();

function ToastIcon({ type }: { type?: string }) {
  if (type === "success") return <CheckCircle2 className="size-4 text-success" aria-hidden />;
  if (type === "error") return <CircleAlert className="size-4 text-destructive" aria-hidden />;
  return <Info className="size-4 text-primary" aria-hidden />;
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      className={cn(
        "pointer-events-auto relative flex w-full items-start gap-3 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg shadow-black/15 outline-none transition-[opacity,transform] duration-200 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0",
        item.type === "error" && "border-destructive/35",
      )}
    >
      <ToastIcon type={item.type} />
      <div className="min-w-0 flex-1">
        <ToastPrimitive.Title className="text-sm font-medium" />
        <ToastPrimitive.Description className="mt-0.5 text-xs/relaxed text-muted-foreground" />
      </div>
      <ToastPrimitive.Close
        type="button"
        aria-label="关闭通知"
        className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
      >
        <X className="size-3.5" aria-hidden />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

export function Toaster({ children }: { children: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider toastManager={toast} limit={3} timeout={4_000}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex w-auto max-w-sm flex-col gap-2 outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function addToast(type: ToastType, title: string, description?: string) {
  return toast.add({
    type,
    title,
    description,
    priority: type === "error" ? "high" : "low",
  });
}

export const notify = {
  success: (title: string, description?: string) => addToast("success", title, description),
  error: (title: string, description?: string) => addToast("error", title, description),
  info: (title: string, description?: string) => addToast("info", title, description),
};

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

/**
 * A single app-level manager keeps command feedback available to mutations
 * initiated from any route, including context menus and portalled controls.
 */
export const toast = ToastPrimitive.createToastManager();

type ToastPortalStore = {
  container: HTMLElement | null;
  setContainer: (container: HTMLElement | null) => void;
};

/**
 * A fullscreen surface owns the browser top layer (and outranks the app chrome
 * even on the desktop native-window path), so the default `<body>` portal is
 * painted underneath it and command feedback disappears silently. Whichever
 * surface is currently fullscreen publishes itself here; the viewport follows.
 */
const useToastPortalStore = create<ToastPortalStore>((set) => ({
  container: null,
  setContainer: (container) => set({ container }),
}));

/** Route toasts into a fullscreen surface; pass `null` to restore `<body>`. */
export function setToastPortalContainer(container: HTMLElement | null): void {
  useToastPortalStore.getState().setContainer(container);
}

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
  const container = useToastPortalStore((state) => state.container);

  return (
    <ToastPrimitive.Provider toastManager={toast} limit={3} timeout={4_000}>
      {children}
      <ToastPrimitive.Portal container={container}>
        {/* Inside a fullscreen player the bottom edge belongs to the control
           bar, so lift the stack clear of it instead of stacking on top. */}
        <ToastPrimitive.Viewport
          data-fullscreen={container ? "true" : undefined}
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex w-auto max-w-sm flex-col gap-2 outline-none data-[fullscreen=true]:bottom-24 sm:right-4 sm:left-auto sm:mx-0 sm:w-full"
        >
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

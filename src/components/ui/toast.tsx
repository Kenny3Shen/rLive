import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

/**
 * 唯一的应用级管理器，使命令反馈对所有路由发起的变更可用，
 * 包括上下文菜单和经过 portal 的控件。
 */
export const toast = ToastPrimitive.createToastManager();

type ToastPortalStore = {
  container: HTMLElement | null;
  setContainer: (container: HTMLElement | null) => void;
};

/**
 * 全屏表面拥有浏览器 top layer（即使在桌面原生窗口路径上也高于应用 chrome），
 * 默认的 `<body>` portal 会被画在它下面，命令反馈就静默消失了。
 * 当前处于全屏的表面把自己发布到这里；viewport 随之跟随。
 */
const useToastPortalStore = create<ToastPortalStore>((set) => ({
  container: null,
  setContainer: (container) => set({ container }),
}));

/** 把 toast 路由进全屏表面；传 `null` 恢复 `<body>`。 */
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
        "motion-toast pointer-events-auto relative flex w-full items-start gap-3 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg shadow-black/15 outline-none data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0",
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
      {/* Base UI 把显式的 `null` 容器视为"尚未解析"，从不创建 portal 节点，因此完全
         省略该属性即可回退到 `<body>`，同时仍允许全屏表面覆盖它。 */}
      <ToastPrimitive.Portal container={container ?? undefined}>
        {/* 在全屏播放器内部，底边属于控制栏，
           因此把整组 toast 抬离它，而不是叠在上面。 */}
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

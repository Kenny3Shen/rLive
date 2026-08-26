declare module "danmu.js" {
  export type DanmuJsMode = "scroll" | "top" | "bottom";

  export type DanmuJsStyle = Record<string, string | number | undefined>;

  export type DanmuJsComment = {
    id: string;
    duration?: number;
    start?: number;
    txt?: string;
    mode?: DanmuJsMode;
    moveV?: number;
    prior?: boolean;
    realTime?: boolean;
    color?: boolean | string;
    style?: DanmuJsStyle;
    el?: HTMLElement;
    elLazyInit?: boolean;
    disableCopyDOM?: boolean;
    [key: string]: unknown;
  };

  export type DanmuJsBullet = {
    id: string;
    el?: HTMLElement;
    mode?: DanmuJsMode;
    options?: DanmuJsComment;
    status?: string;
    [key: string]: unknown;
  };

  export type DanmuJsHooks = {
    bulletCreateEl?: (comment: DanmuJsComment) => HTMLElement | { el: HTMLElement };
    bulletAttaching?: (comment: DanmuJsComment) => void;
    bulletAttached?: (comment: DanmuJsComment, element: HTMLElement) => void;
    bulletDetaching?: (comment: DanmuJsComment) => void;
    bulletDetached?: (comment: DanmuJsComment, element: HTMLElement) => void;
  };

  export type DanmuJsOptions = {
    container: HTMLElement;
    player?: HTMLMediaElement;
    comments?: DanmuJsComment[];
    live?: boolean;
    defaultOff?: boolean;
    area?: { start?: number; end?: number; lines?: number };
    channelSize?: number;
    mouseControl?: boolean;
    mouseControlPause?: boolean;
    needResizeObserver?: boolean;
    maxCommentsLength?: number;
    interval?: number;
    chaseEffect?: boolean;
    disableCopyDOM?: boolean;
    containerStyle?: Record<string, string | number>;
    hooks?: DanmuJsHooks;
  };

  export type DanmuJsEventMap = {
    /**
     * danmu.js 原生 hover 选择。仅为类型完整性声明 —— 应用用自己的按压委托钉住、
     * 并以 `mouseControl: false` 创建实例，因此没有任何地方订阅它。
     */
    bullet_hover: { bullet: DanmuJsBullet; event: Event };
    bullet_attached: unknown;
    bullet_remove: { bullet: DanmuJsBullet };
    destroy: void;
    channel_resize: void;
    ready: void;
    error: unknown;
  };

  export type DanmuJsInstance = {
    status: "idle" | "paused" | "playing" | "closed";
    state: {
      status: string;
      comments: DanmuJsComment[];
      bullets: DanmuJsBullet[];
      displayArea: { width: number; height: number };
    };
    on: <K extends keyof DanmuJsEventMap>(
      event: K,
      listener: (payload: DanmuJsEventMap[K]) => void,
    ) => void;
    off: <K extends keyof DanmuJsEventMap>(
      event: K,
      listener: (payload: DanmuJsEventMap[K]) => void,
    ) => void;
    start: () => void;
    pause: () => void;
    play: () => void;
    stop: () => void;
    clear: () => void;
    destroy: () => void;
    sendComment: (comment: DanmuJsComment) => void;
    updateComments: (comments: DanmuJsComment[], isClear?: boolean) => void;
    removeComment: (id: string) => void;
    freezeComment: (id: string) => void;
    restartComment: (id: string) => void;
    setArea: (area: { start?: number; end?: number; lines?: number; reflow?: boolean }) => void;
    setOpacity: (opacity: number) => void;
    setFontSize: (size: number, channelSize?: number) => void;
    setPlayRate: (mode: DanmuJsMode, rate: number) => void;
    setCommentDuration: (id: string, duration: number) => void;
    hide: (mode?: DanmuJsMode | "color") => void;
    show: (mode?: DanmuJsMode | "color") => void;
    resize: () => void;
    container?: HTMLElement;
    [key: string]: unknown;
  };

  export type DanmuJsConstructor = new (options: DanmuJsOptions) => DanmuJsInstance;

  const DanmuJs: DanmuJsConstructor;
  export { DanmuJs };
  export default DanmuJs;
}

/**
 * 可见焦点指示只属于真实的键盘导航。
 *
 * 移动端侧滑返回、退出全屏这类导航会把焦点交还给上一次操作过的控件。那次聚焦是
 * 程序化的，浏览器却按键盘来源处理，`:focus-visible` 因此成立 —— 于是返回后总有
 * 一个控件（例如刚点过的全屏按钮）带着描边停在那里。
 *
 * 只靠 `:focus-visible` 分不开这两种来源，所以这里另记一份「上一次输入是不是导航
 * 按键」的状态，写在根元素上给 CSS 读。指针一按下就清除：任何点击或轻触之后都不
 * 会再有描边，无论 `:focus-visible` 是否还残留在那个控件上。
 */

/** 只有移动焦点的按键算导航。Enter/Space 是激活，字符键是输入，都不算。 */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** 带光标的输入类型。这些框里方向键移动的是光标，不是焦点。 */
const CARET_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** CSS 侧的读取点：`:root[data-keyboard-nav]`。 */
export const KEYBOARD_NAV_ATTRIBUTE = "data-keyboard-nav";

export function isNavigationKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key);
}

/**
 * 事件目标是不是带光标的文本框。`target` 收成 `unknown`：DOM 的 `EventTarget`
 * 没有 `tagName`，在这里做运行时收窄比给它编一个结构类型诚实。
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tagName === "TEXTAREA") return true;
  if (tagName !== "INPUT") return false;
  // 省略 type 的 <input> 就是 text。
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
  return CARET_INPUT_TYPES.has(type);
}

/** 只需要属性读写，测试因此不必搭一棵真实 DOM。 */
export interface KeyboardNavigationRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** `type` 必选，`DOM Event` 因此可赋给它，`window` 得以直接满足下面的 target。 */
export interface KeyboardNavigationEvent {
  readonly type: string;
  readonly key?: string;
  readonly target?: unknown;
}

export type KeyboardNavigationListener = (event: KeyboardNavigationEvent) => void;

export interface KeyboardNavigationTarget {
  addEventListener(
    type: string,
    listener: KeyboardNavigationListener,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: KeyboardNavigationListener,
    options?: { capture?: boolean },
  ): void;
}

export function setKeyboardNavigation(root: KeyboardNavigationRoot, active: boolean): void {
  if (active) {
    root.setAttribute(KEYBOARD_NAV_ATTRIBUTE, "");
    return;
  }
  root.removeAttribute(KEYBOARD_NAV_ATTRIBUTE);
}

export interface WatchKeyboardNavigationOptions {
  target?: KeyboardNavigationTarget;
  root?: KeyboardNavigationRoot;
}

/** 返回解绑函数；应用整个生命周期都需要监听，调用方通常不必解绑。 */
export function watchKeyboardNavigation(options: WatchKeyboardNavigationOptions = {}): () => void {
  const target = options.target ?? (typeof window === "undefined" ? undefined : window);
  const root =
    options.root ?? (typeof document === "undefined" ? undefined : document.documentElement);
  if (!target || !root) return () => {};

  const handleKeyDown: KeyboardNavigationListener = (event) => {
    const key = event.key;
    if (typeof key !== "string" || !isNavigationKey(key)) return;
    // Tab 一定在控件之间移动焦点。其余导航键在文本框里只是移动光标，焦点没动过，
    // 描边也就不该出现 —— 输入框自己有光标指示打字位置。
    if (key !== "Tab" && isTextEntryTarget(event.target)) return;
    setKeyboardNavigation(root, true);
  };
  const handlePointerDown: KeyboardNavigationListener = () => {
    setKeyboardNavigation(root, false);
  };

  // 捕获阶段：控件自己的 keydown 处理器常调用 stopPropagation（播放器快捷键就是
  // 这么拦方向键的），挂在冒泡阶段会漏掉那些按键。
  const capture = { capture: true };
  target.addEventListener("keydown", handleKeyDown, capture);
  target.addEventListener("pointerdown", handlePointerDown, capture);

  return () => {
    target.removeEventListener("keydown", handleKeyDown, capture);
    target.removeEventListener("pointerdown", handlePointerDown, capture);
  };
}

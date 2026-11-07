/**
 * 首帧前返回按钮与播放中的顶部 HUD 共用同一套定位配方。
 *
 * 普通 Tailwind 间距（`pl-*` / `left-*`）会以 `--spacing` 为单位，`.media-skin`
 * 又把它改成随皮肤缩放的 `--media-spacing`；独立返回按钮曾用 `left-3`（实测
 * 10.8px），播放 HUD 用显式 `0.75rem`（12px）。两种状态各写一套数字也会让
 * 顶部留白相差 5~7px。这里统一显式 rem，供加载占位与首帧前返回按钮复用，
 * 不依赖播放器控制条，轻量舞台骨架可安全导入。
 */

/** HUD 与独立返回按钮的左右内边距；窗口横向安全区更大时由它接管。 */
export const PLAYER_HUD_SURFACE_POSITION_CLASS =
  "pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))]";

/** 顶部内边距；普通舞台的 `--player-safe-area-top` 为 0px，全屏 inset 可由宿主覆盖。 */
export const PLAYER_HUD_SURFACE_TOP_CLASS =
  "pt-[max(0.1875rem,var(--player-safe-area-top,0px))]";

/**
 * 只渲染返回按钮时的绝对定位层：与 HUD 顶行共享左右、顶部留白和移动端密度。
 * 不伪造 `.r-live-player-skin`，以免被舞台的 `<16rem` 容器查询再缩放一次；
 * `data-density` 由调用方设置，dense 变量直接写在这一层，舞台骨架没有
 * `data-player-density` 祖先时也能对齐播放中的 HUD。
 */
export const PLAYER_BACK_ONLY_SURFACE_CLASS = [
  "absolute inset-x-0 top-0 z-30 flex items-center text-white",
  PLAYER_HUD_SURFACE_POSITION_CLASS,
  PLAYER_HUD_SURFACE_TOP_CLASS,
  "pb-3 pointer-events-none [&_button:enabled]:pointer-events-auto [--media-control-size:calc(var(--media-spacing)*9)] data-[density=dense]:[--media-control-size:1.75rem] data-[density=dense]:[--media-icon-size:1.25rem] data-[density=dense]:[&_.r-live-media-extension-button_svg]:size-[1.25rem]",
].join(" ");

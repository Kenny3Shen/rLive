export function isImmersivePlayerPath(pathname: string): boolean {
  return (
    pathname.startsWith("/room/") ||
    pathname.startsWith("/recordings/play/") ||
    pathname === "/iptv/play" ||
    pathname === "/video/play" ||
    pathname === "/multi-room"
  );
}

/**
 * 舞台自己在画面内画顶栏的沉浸路由：Shell 因此不能再为状态栏留 `padding-top`，
 * 画面要一直顶到状态栏之下，安全区由画面内的覆盖层自己让开。
 *
 * 只有直播页与视频播放页属于这一类。`/iptv/play`、`/recordings/play/` 与
 * `/multi-room` 仍保留流内顶栏，撤掉外壳内边距会把它们顶进状态栏。
 */
export function usesOverlayTopBar(pathname: string): boolean {
  return pathname.startsWith("/room/") || pathname === "/video/play";
}

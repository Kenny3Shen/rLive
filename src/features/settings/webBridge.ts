/**
 * Shared shape and helpers for the web-platform bridge, kept out of the React
 * component so the URL/warning logic is unit-testable.
 */
export type WebBridgeInfo = {
  url: string;
  port: number;
  lan_exposed: boolean;
  token: string | null;
};

/**
 * The address to hand to another device.
 *
 * The backend reports the loopback URL because that is what it can prove; a LAN
 * client has to substitute this machine's address, so the host part is left as a
 * placeholder rather than guessed. A token-protected bridge carries the token in
 * the query string, since the first navigation cannot set a header.
 */
export function webBridgeShareUrl(info: WebBridgeInfo, host?: string): string {
  const origin = host ? `http://${host}:${info.port}` : info.url;
  return info.token ? `${origin}/?token=${encodeURIComponent(info.token)}` : origin;
}

export function webBridgeExposureWarning(info: WebBridgeInfo): string | null {
  if (!info.lan_exposed) return null;
  // Anyone who can reach the port drives this machine's rLive: its database,
  // saved accounts and cookies. Say so plainly rather than implying the token
  // makes this equivalent to loopback.
  return "局域网访问已开启。持有链接和令牌的设备可以完全操作本机 rLive 的数据与已登录账号，请只在受信任的网络中使用，用完及时关闭。";
}

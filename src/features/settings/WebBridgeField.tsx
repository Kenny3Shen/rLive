import { useEffect, useState } from "react";
import { Copy, Globe, Square } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
import { notify } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldError, FieldTitle } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { FieldTip } from "./FieldTip";
import { webBridgeExposureWarning, webBridgeShareUrl, type WebBridgeInfo } from "./webBridge";

function messageFromError(error: unknown): string {
  return typeof error === "object" && error && "message" in error
    ? String(error.message)
    : String(error ?? "未知错误");
}

/**
 * Starts and stops the local HTTP bridge that serves rLive to a browser.
 *
 * Deliberately native-only in the UI: a browser tab is already being served by
 * the bridge, and letting it close its own transport (or open the LAN one) would
 * put that decision on the wrong side of the trust boundary.
 */
export function WebBridgeField() {
  const [info, setInfo] = useState<WebBridgeInfo | null>(null);
  const [allowLan, setAllowLan] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invokeCmd<WebBridgeInfo | null>("web_bridge_status")
      .then((current) => {
        if (!current) return;
        setInfo(current);
        setAllowLan(current.lan_exposed);
      })
      .catch(() => {
        // Nothing is running yet, which is the normal cold-start state.
      });
  }, []);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const next = await invokeCmd<WebBridgeInfo>("web_bridge_start", { allowLan });
      setInfo(next);
    } catch (cause) {
      setError(`启动 Web 服务失败：${messageFromError(cause)}`);
    } finally {
      setPending(false);
    }
  }

  async function stop() {
    setPending(true);
    setError(null);
    try {
      await invokeCmd("web_bridge_stop");
      setInfo(null);
    } catch (cause) {
      setError(`停止 Web 服务失败：${messageFromError(cause)}`);
    } finally {
      setPending(false);
    }
  }

  async function copyValue(value: string, label: string) {
    if (await copyText(value)) {
      notify.success(`已复制${label}`);
    } else {
      notify.error(`复制${label}失败`, "请手动选择并复制。");
    }
  }

  const warning = info ? webBridgeExposureWarning(info) : null;

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldContent className="gap-3">
        <FieldTitle>
          <span id="web-bridge-title">浏览器访问</span>
          <FieldTip>
            开启后可用浏览器打开 rLive，直播浏览、播放、弹幕与 IPTV
            均通过本机服务完成。语音字幕、配置档案读写等需要本机权限的功能仍只在客户端可用。
          </FieldTip>
        </FieldTitle>

        {!info ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={allowLan}
                  onCheckedChange={(checked) => setAllowLan(checked === true)}
                />
                允许局域网设备访问
              </label>
              <FieldTip>
                关闭时仅本机可访问（127.0.0.1）；开启后将监听所有网络接口，并生成一次性访问令牌。局域网设备可以浏览和看弹幕，但播放代理只监听本机，暂不能播放。
              </FieldTip>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void start()} disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <Globe data-icon="inline-start" aria-hidden />}
                {pending ? "正在启动…" : "启动 Web 服务"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={info.lan_exposed ? "destructive" : "secondary"}>
                {info.lan_exposed ? "局域网可访问" : "仅本机"}
              </Badge>
              {info.lan_exposed && (
                <FieldTip>
                  局域网设备请把地址中的 127.0.0.1 换成本机的局域网
                  IP，端口与令牌保持不变；这些设备可以浏览和看弹幕，但暂不能播放。
                </FieldTip>
              )}
              <span className="font-mono text-sm break-all">{webBridgeShareUrl(info)}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copyValue(webBridgeShareUrl(info), "访问地址")}
              >
                <Copy data-icon="inline-start" aria-hidden />
                复制地址
              </Button>
            </div>

            {info.token && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">访问令牌</span>
                <span className="font-mono text-xs break-all">{info.token}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copyValue(info.token ?? "", "访问令牌")}
                >
                  <Copy data-icon="inline-start" aria-hidden />
                  复制令牌
                </Button>
              </div>
            )}

            {warning && <FieldError>{warning}</FieldError>}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void stop()} disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <Square data-icon="inline-start" aria-hidden />}
                {pending ? "正在停止…" : "停止 Web 服务"}
              </Button>
            </div>
          </div>
        )}

        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
    </Field>
  );
}

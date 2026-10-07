import { useQuery } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { ProxyMode } from "@/shared/types/live";
import { FieldTip } from "./FieldTip";

export function normalizeHttpProxy(value: string): {
  value: string | null;
  error: string | null;
} {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: "请填写自定义代理地址" };
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { value: null, error: "仅支持 HTTP 或 HTTPS 代理地址" };
    }
    if (!parsed.hostname) return { value: null, error: "请填写代理主机和端口" };
    return { value: parsed.href, error: null };
  } catch {
    return { value: null, error: "请输入有效的代理地址，例如 http://127.0.0.1:7890" };
  }
}

/** 模式和地址分开保存；隐藏输入框不丢弃已保存地址或尚未提交的草稿。 */
export function ProxySettingsFields() {
  const mode = useSettingsStore((s) => s.proxyMode);
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxyMode = useSettingsStore((s) => s.setProxyMode);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const [draft, setDraft] = useState(proxy ?? "");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  // 模式与地址分开保存，错误也分开：各自出现在触发它的那一行里。
  const [modeError, setModeError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  // 导入配置或后端重新加载时对齐草稿；仅切模式时 proxy 不变，草稿仍保留。
  const [previousProxy, setPreviousProxy] = useState(proxy);
  if (proxy !== previousProxy) {
    setPreviousProxy(proxy);
    setDraft(proxy ?? "");
  }

  const status = useQuery({
    queryKey: ["settings", "proxy-status"],
    queryFn: async () => (await invokeCmd<{ proxy_status: string }>("settings_get")).proxy_status,
    enabled: isTauri() && mode === "auto" && !pending,
    refetchInterval: 5_000,
    staleTime: 0,
    retry: false,
  });

  // 不展示「已保存」「正在保存」之类的过程文案：模式与地址的当前状态已由
  // 状态说明行表达，成功是默认路径，只有失败需要占用这一行的位置。
  async function save(change: () => Promise<void>, showError: (message: string) => void) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setModeError(null);
    setAddressError(null);
    try {
      await change();
    } catch {
      // 底层错误可能带含认证信息的 URL，不原样显示。
      showError("代理设置保存失败，请重试");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function changeMode(next: ProxyMode) {
    if (next !== mode) void save(() => setProxyMode(next), setModeError);
  }

  function saveAddress() {
    if (busy.current) return;
    const result = normalizeHttpProxy(draft);
    if (result.error) {
      setAddressError(result.error);
      return;
    }
    void save(() => setProxy(result.value), setAddressError);
  }

  const routeStatus =
    mode === "off"
      ? "直连（不使用代理）"
      : mode === "custom"
        ? proxy
          ? "使用自定义代理"
          : "尚未配置代理地址，当前直连"
        : !isTauri()
          ? "跟随系统代理（请在客户端查看当前出口）"
          : status.isError
            ? "系统代理状态读取失败"
            : status.isFetching && !status.data
              ? "正在读取系统代理…"
              : (status.data ?? "正在读取系统代理…");

  return (
    <>
      {/* 与其他设置行一致：标题说明在左、控件在右，反馈文字留在本行内，
          而不是另起一条看起来像新设置项的边框行。 */}
      <Field orientation="horizontal" data-disabled={pending || undefined}>
        <FieldContent className="min-w-0">
          <FieldTitle>
            <span id="proxy-mode-label">代理模式</span>
            <FieldTip>
              自动跟随系统代理；关闭忽略系统代理和环境变量；自定义使用下方地址。
              切换模式会保留自定义地址，已建立的播放、录制与登录会话需重新连接。
            </FieldTip>
          </FieldTitle>
          {modeError ? (
            <FieldError>{modeError}</FieldError>
          ) : (
            <FieldDescription role="status" aria-live="polite" className="wrap-anywhere">
              {routeStatus}
            </FieldDescription>
          )}
        </FieldContent>
        {/* 本行比只有标题的行高（标题下多一行状态说明），控件要居中于整行，
            而不是像“有说明就顶部对齐”的默认那样贴在标题那一行。 */}
        <ToggleGroup
          aria-labelledby="proxy-mode-label"
          className="self-center"
          value={[mode]}
          variant="outline"
          size="sm"
          spacing={1}
          disabled={pending}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "auto" || next === "off" || next === "custom") changeMode(next);
          }}
        >
          <ToggleGroupItem value="auto">自动</ToggleGroupItem>
          <ToggleGroupItem value="off">关闭</ToggleGroupItem>
          <ToggleGroupItem value="custom">自定义</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {mode === "custom" && (
        <Field data-invalid={addressError ? true : undefined} data-disabled={pending || undefined}>
          <div className="flex items-center gap-1.5">
            <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
            <FieldTip>支持 HTTP 与 HTTPS 代理；可省略 http:// 前缀。</FieldTip>
          </div>
          <FieldContent>
            <form
              className="w-full"
              onSubmit={(event) => {
                event.preventDefault();
                saveAddress();
              }}
            >
              <InputGroup>
                <InputGroupInput
                  id="proxy"
                  inputMode="url"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  disabled={pending}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setAddressError(null);
                  }}
                  placeholder="http://127.0.0.1:7890"
                  aria-invalid={addressError ? true : undefined}
                  aria-describedby={addressError ? "proxy-error" : undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton type="submit" variant="secondary" size="sm" disabled={pending}>
                    保存
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
            {addressError && <FieldError id="proxy-error">{addressError}</FieldError>}
          </FieldContent>
        </Field>
      )}
    </>
  );
}

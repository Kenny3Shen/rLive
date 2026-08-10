import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, RefreshCw, Upload, X } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { notify } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  lanSyncCountdown,
  normalizeLanSyncCode,
  profileImportSummary,
  validateLanSyncReceiver,
  type LanSyncSessionInfo,
  type ProfileImportResult,
} from "./lanSync";

type LanSyncMode = "send" | "receive";

function messageFromError(error: unknown): string {
  return typeof error === "object" && error && "message" in error
    ? String(error.message)
    : String(error ?? "未知错误");
}

function sessionStatusLabel(session: LanSyncSessionInfo): string {
  switch (session.status) {
    case "completed":
      return "传输完成";
    case "expired":
      return "会话已过期";
    case "locked":
      return "会话已锁定";
    case "stopped":
      return "会话已停止";
    default:
      return "等待连接";
  }
}

export function LanSyncField() {
  const queryClient = useQueryClient();
  const loadFromBackend = useSettingsStore((state) => state.loadFromBackend);
  const activeSessionRef = useRef(false);
  const [mode, setMode] = useState<LanSyncMode>("send");
  const [session, setSession] = useState<LanSyncSessionInfo | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [receivePending, setReceivePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileImportResult | null>(null);
  const [now, setNow] = useState(Date.now());

  activeSessionRef.current = session?.status === "waiting";

  useEffect(() => {
    if (session?.status !== "waiting") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await invokeCmd<LanSyncSessionInfo | null>("lan_sync_status");
        if (!cancelled && next) setSession(next);
      } catch {
        // The visible session remains usable; the next tick can recover status.
      }
      if (!cancelled) setNow(Date.now());
    };

    const interval = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [session?.status]);

  useEffect(() => {
    return () => {
      if (activeSessionRef.current) void invokeCmd("lan_sync_stop").catch(() => {});
    };
  }, []);

  async function startSession() {
    setSendPending(true);
    setError(null);
    setResult(null);
    try {
      const next = await invokeCmd<LanSyncSessionInfo>("lan_sync_start");
      setNow(Date.now());
      setSession(next);
    } catch (cause) {
      setSession(null);
      setError(`创建同步会话失败：${messageFromError(cause)}`);
    } finally {
      setSendPending(false);
    }
  }

  async function stopSession(): Promise<boolean> {
    try {
      await invokeCmd("lan_sync_stop");
      setSession(null);
      return true;
    } catch (cause) {
      setError(`停止同步会话失败：${messageFromError(cause)}`);
      return false;
    }
  }

  async function copyValue(value: string, label: string) {
    if (await copyText(value)) {
      notify.success(`已复制${label}`);
    } else {
      notify.error(`复制${label}失败`, "请手动选择并复制。");
    }
  }

  async function receiveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateLanSyncReceiver(address, code);
    if (validationError) {
      setError(validationError);
      return;
    }

    setReceivePending(true);
    setError(null);
    setResult(null);
    try {
      const imported = await invokeCmd<ProfileImportResult>("lan_sync_receive", {
        address: address.trim(),
        code: code.trim(),
      });
      await loadFromBackend();
      await queryClient.invalidateQueries({ refetchType: "active" });
      setResult(imported);
      notify.success("局域网同步完成");
    } catch (cause) {
      setError(`同步失败：${messageFromError(cause)}`);
    } finally {
      setReceivePending(false);
    }
  }

  async function changeMode(next: LanSyncMode) {
    if (next === mode) return;
    if (session?.status === "waiting" && !(await stopSession())) return;
    setMode(next);
    setError(null);
    setResult(null);
  }

  const waiting = session?.status === "waiting";

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldContent className="gap-3">
        <FieldTitle id="lan-sync-mode-label">同步方式</FieldTitle>
        <ToggleGroup
          aria-labelledby="lan-sync-mode-label"
          value={[mode]}
          variant="outline"
          size="sm"
          spacing={1}
          className="w-full"
          onValueChange={(values) => {
            const next = values[0];
            if (next === "send" || next === "receive") void changeMode(next);
          }}
        >
          <ToggleGroupItem value="send" className="flex-1">
            发送配置
          </ToggleGroupItem>
          <ToggleGroupItem value="receive" className="flex-1">
            接收配置
          </ToggleGroupItem>
        </ToggleGroup>

        {mode === "send" ? (
          <FieldGroup className="gap-3">
            {!session ? (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldDescription>
                    创建一次性会话后，在另一台 rLive 设备输入同步地址和配对码。
                  </FieldDescription>
                </FieldContent>
                <Button type="button" disabled={sendPending} onClick={() => void startSession()}>
                  {sendPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Upload data-icon="inline-start" aria-hidden />
                  )}
                  {sendPending ? "正在创建…" : "创建同步会话"}
                </Button>
              </Field>
            ) : (
              <>
                <Field orientation="responsive">
                  <FieldContent>
                    <div className="flex flex-wrap items-center gap-2">
                      <FieldTitle>会话状态</FieldTitle>
                      <Badge variant={session.status === "completed" ? "secondary" : "outline"}>
                        {waiting && <Spinner data-icon="inline-start" aria-hidden />}
                        {session.status === "completed" && (
                          <Check data-icon="inline-start" aria-hidden />
                        )}
                        {sessionStatusLabel(session)}
                      </Badge>
                    </div>
                    {waiting && (
                      <FieldDescription>
                        剩余 {lanSyncCountdown(session.expires_at, now)}，成功传输一次后自动关闭。
                      </FieldDescription>
                    )}
                  </FieldContent>
                  <div className="flex gap-2">
                    {waiting ? (
                      <Button type="button" variant="outline" size="sm" onClick={stopSession}>
                        <X data-icon="inline-start" aria-hidden />
                        停止
                      </Button>
                    ) : (
                      <Button type="button" variant="outline" size="sm" onClick={startSession}>
                        <RefreshCw data-icon="inline-start" aria-hidden />
                        重新创建
                      </Button>
                    )}
                  </div>
                </Field>

                {waiting && (
                  <>
                    <Field>
                      <FieldLabel>同步地址</FieldLabel>
                      <FieldGroup className="gap-2">
                        {session.addresses.map((item) => (
                          <InputGroup key={item}>
                            <InputGroupInput value={item} readOnly aria-label="同步地址" />
                            <InputGroupAddon align="inline-end">
                              <InputGroupButton
                                type="button"
                                size="icon-sm"
                                aria-label="复制同步地址"
                                onClick={() => void copyValue(item, "同步地址")}
                              >
                                <Copy aria-hidden />
                              </InputGroupButton>
                            </InputGroupAddon>
                          </InputGroup>
                        ))}
                      </FieldGroup>
                    </Field>
                    <Field>
                      <FieldLabel>配对码</FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          value={session.code}
                          readOnly
                          aria-label="配对码"
                          className="font-mono text-lg tabular-nums"
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            size="icon-sm"
                            aria-label="复制配对码"
                            onClick={() => void copyValue(session.code, "配对码")}
                          >
                            <Copy aria-hidden />
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </Field>
                  </>
                )}
              </>
            )}
          </FieldGroup>
        ) : (
          <form onSubmit={receiveProfile}>
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="lan-sync-address">同步地址</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="lan-sync-address"
                    value={address}
                    inputMode="url"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="192.168.1.20:43210"
                    disabled={receivePending}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => {
                      setAddress(event.target.value);
                      setError(null);
                    }}
                  />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="lan-sync-code">6 位配对码</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="lan-sync-code"
                    value={code}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    maxLength={6}
                    disabled={receivePending}
                    aria-invalid={error ? true : undefined}
                    className="font-mono tabular-nums"
                    onChange={(event) => {
                      setCode(normalizeLanSyncCode(event.target.value));
                      setError(null);
                    }}
                  />
                </InputGroup>
              </Field>
              <Button type="submit" className="w-fit" disabled={receivePending}>
                {receivePending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" aria-hidden />
                )}
                {receivePending ? "正在同步…" : "接收并合并"}
              </Button>
            </FieldGroup>
          </form>
        )}

        <FieldDescription>
          同步关注、分组、历史和通用设置；不包含 Cookie、发送授权、ASR 本机配置或私有 M3U 地址。
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
        {result && (
          <FieldDescription role="status" aria-live="polite">
            {profileImportSummary(result)}
          </FieldDescription>
        )}
      </FieldContent>
    </Field>
  );
}

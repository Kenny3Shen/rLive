import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  Download,
  ExternalLink,
  Info,
  MonitorPlay,
  Network,
  Power,
  QrCode,
  Radio,
  RefreshCw,
  ShieldAlert,
  Upload,
  UserRound,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { invokeCmd } from "@/shared/api/tauri";
import { invalidateCookieDependentSiteQueries } from "@/shared/api/cookieQueryInvalidation";
import { enabledSiteIds, LIVE_SITE_IDS } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { PageHeader } from "@/shared/components/PageHeader";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { cn, SITE_LABELS } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type SettingsCategory = "playback" | "platform" | "network" | "account" | "data" | "about";

type AccountLoginMethod = "manual" | "qr";

type AccountQrLoginStart = {
  qr_code_url: string;
  qr_key: string;
};

type AccountQrLoginPoll = {
  status: "pending" | "scanned" | "expired" | "success";
  message: string;
};

type AccountProfile = {
  username: string | null;
  has_cookie: boolean;
};

type AsrModelStatus = {
  loaded: boolean;
  loading: boolean;
  bundled: boolean;
  path: string | null;
  active_session_id: string | null;
  queue_depth: number;
  queue_capacity: number;
  sample_rate_hz: number;
  backend: string;
  cpu_only: boolean;
  speech_gate_active: boolean;
};

const settingsCategories: {
  value: SettingsCategory;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "playback", label: "播放", icon: MonitorPlay },
  { value: "platform", label: "平台", icon: Radio },
  { value: "network", label: "网络", icon: Network },
  { value: "account", label: "账号", icon: UserRound },
  { value: "data", label: "数据", icon: Database },
  { value: "about", label: "关于", icon: Info },
];

const PROJECT_HOMEPAGE_URL = "https://github.com/Kenny3Shen/rLive";
const PROFILE_FILE_FILTERS = [{ name: "rLive 配置档案", extensions: ["json"] }];

function errorMessage(cause: unknown): string {
  return typeof cause === "object" && cause && "message" in cause
    ? String((cause as { message: string }).message)
    : String(cause);
}

function useCompactSettingsLayout(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function isDanmakuSendCookieSite(siteId: SiteId): boolean {
  return siteId === "bilibili" || siteId === "douyu" || siteId === "huya";
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FieldSet>
          <FieldLegend className="sr-only">{title}</FieldLegend>
          <FieldGroup className="gap-3">{children}</FieldGroup>
        </FieldSet>
      </CardContent>
    </Card>
  );
}

function QrLogin({
  siteId,
  siteName,
  onSaved,
}: {
  siteId: SiteId;
  siteName: string;
  onSaved: () => Promise<void>;
}) {
  const [session, setSession] = useState<AccountQrLoginStart | null>(null);
  const [status, setStatus] = useState("正在获取二维码…");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setSession(null);
    setStatus("正在获取二维码…");
    try {
      const next = await invokeCmd<AccountQrLoginStart>("account_qr_login_start", {
        siteId,
      });
      setSession(next);
      setStatus(`请使用${siteName} App 扫描二维码`);
    } catch (error) {
      const message =
        typeof error === "object" && error && "message" in error
          ? String((error as { message: string }).message)
          : String(error);
      setStatus(`获取二维码失败：${message}`);
    } finally {
      setLoading(false);
    }
  }, [siteId, siteName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let polling = false;
    let interval: number | null = null;

    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        const result = await invokeCmd<AccountQrLoginPoll>("account_qr_login_poll", {
          siteId,
          qrKey: session.qr_key,
        });
        if (cancelled) return;
        setStatus(result.message);
        if (result.status === "success") {
          await onSaved();
        }
        if (result.status === "success" || result.status === "expired") {
          if (interval !== null) window.clearInterval(interval);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            typeof error === "object" && error && "message" in error
              ? String((error as { message: string }).message)
              : String(error);
          setStatus(`扫码状态检查失败：${message}`);
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    interval = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [onSaved, session, siteId]);

  return (
    <Field>
      <FieldContent>
        <div className="flex flex-wrap items-center gap-4">
          <div className="rounded-xl border border-border-subtle bg-card p-2 shadow-sm">
            {session ? (
              <QRCodeSVG
                value={session.qr_code_url}
                size={176}
                level="M"
                includeMargin={false}
                fgColor="#111111"
                bgColor="#ffffff"
                title={`${siteName}登录二维码`}
              />
            ) : (
              <div className="flex size-44 items-center justify-center text-muted-foreground">
                <RefreshCw className="size-5 animate-spin-soft" aria-hidden />
                <span className="sr-only">正在加载二维码</span>
              </div>
            )}
          </div>
          <div className="flex min-w-44 flex-1 flex-col gap-2">
            <p className="text-sm font-medium">手机扫码登录</p>
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              刷新二维码
            </Button>
          </div>
        </div>
        <FieldDescription>确认后 Cookie 直接保存到本机，不会显示或上传。</FieldDescription>
      </FieldContent>
    </Field>
  );
}

function AccountCard({
  siteId,
  title,
  description,
  placeholder,
  qrLogin = false,
}: {
  siteId: SiteId;
  title: string;
  description: string;
  placeholder: string;
  qrLogin?: boolean;
}) {
  const queryClient = useQueryClient();
  const markDanmakuCookieChanged = useSettingsStore((s) => s.markDanmakuCookieChanged);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<AccountLoginMethod | null>(null);
  const [cookieDraft, setCookieDraft] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const inputId = `${siteId}-cookie`;

  const refreshCookieDependentQueries = useCallback(() => {
    // The Cookie write has already succeeded at this point. A failed network
    // refresh must not turn that successful account update into a UI error;
    // the affected query keeps its own error state and remains stale to retry.
    void invalidateCookieDependentSiteQueries(queryClient, siteId).catch(() => {});
  }, [queryClient, siteId]);

  const refreshProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError(null);
    if (!isTauri()) {
      setProfile({ username: null, has_cookie: false });
      setProfileLoading(false);
      return;
    }
    try {
      const next = await invokeCmd<AccountProfile>("account_get_profile", { siteId });
      setProfile(next);
    } catch (error) {
      setProfile(null);
      setProfileError(`账号状态读取失败：${errorMessage(error)}`);
    } finally {
      setProfileLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const applySavedCookie = useCallback(
    async (message: string) => {
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
      refreshCookieDependentQueries();
      await refreshProfile();
      setNotice(message);
    },
    [markDanmakuCookieChanged, refreshCookieDependentQueries, refreshProfile, siteId],
  );

  function closeLoginDialog() {
    if (saving) return;
    setLoginMethod(null);
    setCookieDraft("");
    setManualError(null);
  }

  async function saveCookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cookie = cookieDraft.trim();
    if (!cookie) {
      setManualError("请输入完整 Cookie。");
      return;
    }

    setSaving(true);
    setManualError(null);
    try {
      await invokeCmd<void>("account_set_cookie", { siteId, cookie });
      await applySavedCookie("Cookie 已保存，账号信息已更新。");
      setLoginMethod(null);
      setCookieDraft("");
    } catch (error) {
      setManualError(`保存失败：${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearCookie() {
    setClearing(true);
    setProfileError(null);
    try {
      await invokeCmd<void>("account_clear_cookie", { siteId });
      await applySavedCookie("已退出当前账号。");
    } catch (error) {
      setProfileError(`退出登录失败：${errorMessage(error)}`);
    } finally {
      setClearing(false);
    }
  }

  const displayName = profile?.username ?? null;
  const hasCookie = profile?.has_cookie ?? false;
  const accountName = profileLoading
    ? "正在读取账号"
    : (displayName ?? (hasCookie ? "已保存登录态" : "未登录"));
  const accountDescription = profileLoading
    ? "正在读取本机保存的账号状态。"
    : displayName
      ? `当前账号用户名：${displayName}`
      : hasCookie
        ? "Cookie 已保存，暂未能识别用户名。"
        : "选择登录方式后，在弹窗中完成账号连接。";

  return (
    <Section title={title} description={description}>
      <Field orientation="responsive">
        <FieldContent>
          <div className="flex flex-wrap items-center gap-2">
            <FieldTitle>{accountName}</FieldTitle>
            <Badge variant={hasCookie ? "secondary" : "outline"}>
              {hasCookie ? "已登录" : "未登录"}
            </Badge>
          </div>
          <FieldDescription>{accountDescription}</FieldDescription>
          {notice && <FieldDescription role="status">{notice}</FieldDescription>}
          {profileError && <FieldError>{profileError}</FieldError>}
        </FieldContent>
        <div className="flex flex-wrap items-center gap-2">
          {qrLogin ? (
            <ToggleGroup
              aria-label={`${title}登录方式`}
              value={loginMethod ? [loginMethod] : []}
              variant="outline"
              size="sm"
              spacing={1}
              onValueChange={(values) => {
                const method = values[0];
                if (method === "manual" || method === "qr") setLoginMethod(method);
              }}
            >
              <ToggleGroupItem value="qr">
                <QrCode data-icon="inline-start" aria-hidden />
                扫码登录
              </ToggleGroupItem>
              <ToggleGroupItem value="manual">手动输入</ToggleGroupItem>
            </ToggleGroup>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setLoginMethod("manual")}>
              手动输入
            </Button>
          )}
          {hasCookie && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clearCookie()}
              disabled={clearing}
            >
              {clearing ? <Spinner data-icon="inline-start" /> : null}
              退出登录
            </Button>
          )}
        </div>
      </Field>

      <Dialog
        open={loginMethod === "qr"}
        onOpenChange={(open) => {
          if (!open) closeLoginDialog();
        }}
      >
        {loginMethod === "qr" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}扫码登录</DialogTitle>
              <DialogDescription>请使用 {title} App 扫描二维码并在手机上确认。</DialogDescription>
            </DialogHeader>
            <QrLogin
              siteId={siteId}
              siteName={title}
              onSaved={async () => {
                await applySavedCookie("扫码登录成功，当前账号已更新。");
                setLoginMethod(null);
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={closeLoginDialog}>
                取消
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={loginMethod === "manual"}
        onOpenChange={(open) => {
          if (!open) closeLoginDialog();
        }}
      >
        {loginMethod === "manual" && (
          <DialogContent>
            <form onSubmit={(event) => void saveCookie(event)}>
              <DialogHeader>
                <DialogTitle>{title}手动输入 Cookie</DialogTitle>
                <DialogDescription>
                  Cookie 仅保存在本机，用于读取当前账号和平台登录态。
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="mt-4">
                <Field data-invalid={manualError ? true : undefined}>
                  <FieldLabel htmlFor={inputId}>Cookie</FieldLabel>
                  <Textarea
                    id={inputId}
                    value={cookieDraft}
                    onChange={(event) => {
                      setCookieDraft(event.target.value);
                      setManualError(null);
                    }}
                    rows={6}
                    placeholder={placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={saving}
                    aria-invalid={manualError ? true : undefined}
                  />
                  <FieldDescription>
                    保存后会自动读取当前账号用户名，Cookie 不会在设置页显示。
                  </FieldDescription>
                  {manualError && <FieldError>{manualError}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter className="mt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeLoginDialog}
                  disabled={saving}
                >
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  保存并识别账号
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </Section>
  );
}

function DanmakuSendField() {
  const enabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const setEnabled = useSettingsStore((s) => s.setDanmakuSendEnabled);

  return (
    <Section title="弹幕发送" description="支持 B站、斗鱼、虎牙的普通文本弹幕。">
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle id="danmaku-send-title">允许发送弹幕</FieldTitle>
          <FieldDescription>还需为对应平台保存有效 Cookie，否则发送框保持禁用。</FieldDescription>
        </FieldContent>
        <Switch
          aria-labelledby="danmaku-send-title"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </Field>
    </Section>
  );
}

function IptvCustomM3uUrlField() {
  const customM3uUrl = useSettingsStore((s) => s.iptvCustomM3uUrl);
  const setCustomM3uUrl = useSettingsStore((s) => s.setIptvCustomM3uUrl);
  const [draft, setDraft] = useState(customM3uUrl ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(customM3uUrl ?? "");
  }, [customM3uUrl]);

  function save() {
    const next = draft.trim();
    if (next && !isHttpM3uUrl(next)) {
      setStatus(null);
      setError("请输入以 http:// 或 https:// 开头的 M3U 地址");
      return;
    }
    setError(null);
    setCustomM3uUrl(next || null);
    setStatus(next ? "自定义 M3U 地址已保存" : "自定义 M3U 地址已清除");
  }

  return (
    <Section title="IPTV 源" description="可选：供 IPTV 页面加载的自定义频道源。">
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="iptv-custom-m3u-url">M3U 地址</FieldLabel>
        <FieldContent>
          <form
            className="w-full"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <InputGroup>
              <InputGroupInput
                id="iptv-custom-m3u-url"
                type="url"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="https://example.com/playlist.m3u"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton type="submit" variant="secondary" size="sm">
                  保存
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <FieldDescription>
            仅保存在本机，不随配置导入导出。请确认来源与内容授权。
          </FieldDescription>
          {error ? (
            <FieldError>{error}</FieldError>
          ) : (
            status && <FieldDescription>{status}</FieldDescription>
          )}
        </FieldContent>
      </Field>
    </Section>
  );
}

function LocalCaptionModelField() {
  const nativeRuntime = isTauri();
  const [modelStatus, setModelStatus] = useState<AsrModelStatus | null>(null);
  const [action, setAction] = useState<"status" | "default" | "unload" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!nativeRuntime) return;
    setAction("status");
    setError(null);
    try {
      const next = await invokeCmd<AsrModelStatus>("asr_model_status");
      setModelStatus(next);
      setNotice(null);
    } catch (cause) {
      const message =
        typeof cause === "object" && cause && "message" in cause
          ? String((cause as { message: string }).message)
          : String(cause);
      setError(`无法读取本地字幕模型状态：${message}`);
    } finally {
      setAction(null);
    }
  }, [nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime) return;
    void refreshStatus();
  }, [nativeRuntime, refreshStatus]);

  async function loadDefaultModel() {
    setAction("default");
    setError(null);
    setNotice(null);
    try {
      const next = await invokeCmd<AsrModelStatus>("asr_model_load_default");
      setModelStatus(next);
      setNotice("内置字幕模型已加载，可在直播间开启实时字幕");
    } catch (cause) {
      const message =
        typeof cause === "object" && cause && "message" in cause
          ? String((cause as { message: string }).message)
          : String(cause);
      setError(`加载内置模型失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function unloadModel() {
    setAction("unload");
    setError(null);
    setNotice(null);
    try {
      const next = await invokeCmd<AsrModelStatus>("asr_model_unload");
      setModelStatus(next);
      setNotice("本地字幕模型已卸载；下次开启字幕会按需重新加载");
    } catch (cause) {
      const message =
        typeof cause === "object" && cause && "message" in cause
          ? String((cause as { message: string }).message)
          : String(cause);
      setError(`卸载模型失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  const loading = action === "default" || modelStatus?.loading === true;
  const statusLabel = !nativeRuntime
    ? "仅应用内可用"
    : action === "status"
      ? "检查中"
      : modelStatus?.loading
        ? "加载中"
        : modelStatus?.loaded
          ? "已加载"
          : "未加载";

  return (
    <Section title="本地字幕" description="音频仅在本机识别，模型按需加载。">
      <Field data-invalid={error ? true : undefined}>
        <FieldContent>
          <div className="flex flex-wrap items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldTitle>内置模型</FieldTitle>
              <FieldDescription>Whisper tiny · 多语言 · Q4 · 约 23 MB</FieldDescription>
            </div>
            <Badge variant={modelStatus?.loaded ? "secondary" : "outline"}>{statusLabel}</Badge>
          </div>
          {nativeRuntime ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void loadDefaultModel()}
                  disabled={
                    loading ||
                    action === "status" ||
                    (modelStatus?.loaded === true && modelStatus.bundled)
                  }
                >
                  {action === "default" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <MonitorPlay data-icon="inline-start" aria-hidden />
                  )}
                  {action === "default" ? "加载中…" : "加载模型"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void unloadModel()}
                  disabled={action !== null || !modelStatus?.loaded}
                >
                  {action === "unload" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Power data-icon="inline-start" aria-hidden />
                  )}
                  {action === "unload" ? "卸载中…" : "卸载"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void refreshStatus()}
                  disabled={action !== null}
                >
                  {action === "status" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" aria-hidden />
                  )}
                  刷新
                </Button>
              </div>
              {notice && (
                <FieldDescription role="status" aria-live="polite">
                  {notice}
                </FieldDescription>
              )}
              {error && <FieldError>{error}</FieldError>}
            </>
          ) : (
            <FieldDescription role="status">请在 rLive 应用中管理模型。</FieldDescription>
          )}
        </FieldContent>
      </Field>
    </Section>
  );
}

function isHttpM3uUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpProxy(value: string): { value: string | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { value: null, error: "仅支持 HTTP 或 HTTPS 代理地址" };
    }
    if (!parsed.hostname) {
      return { value: null, error: "请填写代理主机和端口" };
    }
    return { value: parsed.href, error: null };
  } catch {
    return { value: null, error: "请输入有效的代理地址，例如 http://127.0.0.1:7890" };
  }
}

function PlatformEnablementField() {
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const setSiteEnabled = useSettingsStore((s) => s.setSiteEnabled);
  const enabled = enabledSiteIds(disabledSiteIds);

  return (
    <Section title="直播平台" description="关闭的平台不会出现在首页、分类和搜索中。">
      {LIVE_SITE_IDS.map((siteId) => {
        const isEnabled = enabled.includes(siteId);
        const isLastEnabled = isEnabled && enabled.length === 1;
        const titleId = `platform-${siteId}-enabled`;

        return (
          <Field key={siteId} orientation="responsive" data-disabled={isLastEnabled || undefined}>
            <FieldContent>
              <FieldTitle id={titleId}>
                <SiteLogo siteId={siteId} className="size-5" />
                {SITE_LABELS[siteId] ?? siteId}
              </FieldTitle>
              <FieldDescription>
                {isLastEnabled ? "需至少保留一个平台" : isEnabled ? "已启用" : "已关闭"}
              </FieldDescription>
            </FieldContent>
            <Switch
              aria-labelledby={titleId}
              checked={isEnabled}
              disabled={isLastEnabled}
              onCheckedChange={(checked) => setSiteEnabled(siteId, checked)}
            />
          </Field>
        );
      })}
    </Section>
  );
}

function AboutSettings() {
  function openProjectHomepage() {
    void openUrl(PROJECT_HOMEPAGE_URL).catch(() => {
      // Keep the link useful in a browser-based development preview, where
      // the native opener plugin is intentionally unavailable.
      window.open(PROJECT_HOMEPAGE_URL, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertDialog>
        <Section title="关于 rLive">
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle id="project-homepage">项目主页</FieldTitle>
              <FieldDescription>源代码、版本动态与问题反馈</FieldDescription>
            </FieldContent>
            <Button onClick={openProjectHomepage} variant="outline">
              <ExternalLink data-icon="inline-start" aria-hidden />
              GitHub
            </Button>
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle id="disclaimer-title">免责声明</FieldTitle>
              <FieldDescription>
                rLive 仅提供本地客户端功能，不托管直播内容，也不代表任何直播平台。
              </FieldDescription>
            </FieldContent>
            <AlertDialogTrigger
              render={
                <Button variant="outline">
                  <ShieldAlert data-icon="inline-start" aria-hidden />
                  查看
                </Button>
              }
            />
          </Field>
        </Section>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldAlert aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>免责声明</AlertDialogTitle>
            <AlertDialogDescription>
              rLive
              是本地桌面直播客户端，不托管、制作或控制任何第三方直播内容，也不代表或隶属于任何直播平台。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              使用直播平台、账号、Cookie、节目源和互动功能时，请确认你拥有相应授权，并遵守平台规则、内容版权、隐私要求及所在地法律。
            </p>
            <p>
              第三方服务、内容可用性和访问条件可能随时变化；rLive
              不对其持续可用性、准确性或适用性作出保证。
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>我已了解</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<"import" | "export" | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("playback");
  const compactLayout = useCompactSettingsLayout();
  const categoryTabRefs = useRef(new Map<SettingsCategory, HTMLButtonElement | null>());

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  useEffect(() => {
    if (!compactLayout) return;
    const activeTab = categoryTabRefs.current.get(category);
    if (!activeTab) return;

    // A compact tab strip intentionally scrolls horizontally. Keep keyboard
    // and programmatic category changes discoverable instead of leaving the
    // newly selected panel's trigger offscreen.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeTab.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [category, compactLayout]);

  function saveProxy() {
    setProxyStatus(null);
    const next = normalizeHttpProxy(proxyDraft);
    if (next.error) {
      setProxyError(next.error);
      return;
    }
    setProxyError(null);
    setProxy(next.value);
    setProxyDraft(next.value ?? "");
    setProxyStatus(next.value ? "代理已保存，将用于后续请求" : "代理已关闭，后续请求将直连");
  }

  async function exportProfile(path: string) {
    setProfileStatus(null);
    setProfileError(null);
    setProfileAction("export");
    try {
      await invokeCmd("profile_export", { path });
      setProfileStatus("配置已导出。档案不包含 Cookie、发送授权或本机路径。");
    } catch (cause) {
      setProfileError(`导出失败：${errorMessage(cause)}`);
    } finally {
      setProfileAction(null);
    }
  }

  async function importProfile(path: string) {
    setProfileStatus(null);
    setProfileError(null);
    setProfileAction("import");
    try {
      const r = await invokeCmd<{
        follows: number;
        tags: number;
        history: number;
        settings: boolean;
      }>("profile_import", { path });
      await loadFromBackend();
      // Import can change settings as well as follows/history. Mark every
      // cached page stale and immediately refresh pages currently on screen,
      // so the shell cannot show an old platform or stale local data.
      await queryClient.invalidateQueries({ refetchType: "active" });
      setProfileStatus(`已导入：${r.follows} 个关注、${r.tags} 个标签、${r.history} 条历史记录。`);
    } catch (cause) {
      setProfileError(`导入失败：${errorMessage(cause)}`);
    } finally {
      setProfileAction(null);
    }
  }

  async function chooseProfileForImport() {
    if (profileAction) return;
    setProfileStatus(null);
    setProfileError(null);
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        title: "导入 rLive 配置档案",
        filters: PROFILE_FILE_FILTERS,
      });
      if (typeof path === "string") {
        await importProfile(path);
      }
    } catch (cause) {
      setProfileError(`打开导入文件失败：${errorMessage(cause)}`);
    }
  }

  async function chooseProfileForExport() {
    if (profileAction) return;
    setProfileStatus(null);
    setProfileError(null);
    try {
      const path = await saveFileDialog({
        title: "导出 rLive 配置档案",
        defaultPath: "rlive-profile.json",
        filters: PROFILE_FILE_FILTERS,
      });
      if (typeof path === "string") {
        await exportProfile(path);
      }
    } catch (cause) {
      setProfileError(`选择导出位置失败：${errorMessage(cause)}`);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader title="设置" />

      <Tabs
        value={category}
        orientation={compactLayout ? "horizontal" : "vertical"}
        className={cn("gap-4", compactLayout ? "min-h-0" : "min-h-[32rem]")}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
      >
        <TabsList
          aria-label="设置分类"
          className={cn(
            "shrink-0 rounded-xl border border-border-subtle bg-card/60 p-1",
            compactLayout
              ? "scroll-fade-x sticky top-0 z-10 h-12! w-full flex-row! justify-start overflow-x-auto"
              : "w-44",
          )}
        >
          {settingsCategories.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              ref={(node) => {
                categoryTabRefs.current.set(value, node);
              }}
              className={cn(
                "h-11 shrink-0 gap-2 rounded-lg px-3 py-2",
                compactLayout ? "w-auto! flex-none! justify-center text-center" : "text-left",
              )}
            >
              <Icon aria-hidden />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-w-0 flex-1">
          {category === "playback" && (
            <TabsContent value="playback" className="mt-0">
              <SettingsContent title="播放">
                <Section title="清晰度">
                  <Field orientation="responsive">
                    <FieldContent>
                      <FieldTitle id="quality-label">优先清晰度</FieldTitle>
                      <FieldDescription>有可用线路时优先选择此档</FieldDescription>
                    </FieldContent>
                    <ToggleGroup
                      aria-labelledby="quality-label"
                      value={[qualityLevel]}
                      variant="outline"
                      size="sm"
                      spacing={1}
                      onValueChange={(values) => {
                        const next = values[0];
                        if (next === "high" || next === "mid" || next === "low") {
                          setQualityLevel(next);
                        }
                      }}
                    >
                      <ToggleGroupItem value="high">最高</ToggleGroupItem>
                      <ToggleGroupItem value="mid">中间</ToggleGroupItem>
                      <ToggleGroupItem value="low">最低</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                </Section>
                <LocalCaptionModelField />
              </SettingsContent>
            </TabsContent>
          )}

          {category === "platform" && (
            <TabsContent value="platform" className="mt-0">
              <SettingsContent title="平台">
                <PlatformEnablementField />
              </SettingsContent>
            </TabsContent>
          )}

          {category === "network" && (
            <TabsContent value="network" className="mt-0">
              <SettingsContent title="网络">
                <div className="flex flex-col gap-4">
                  <Section title="代理" description="可选：用于全部平台请求的 HTTP(S) 代理。">
                    <Field data-invalid={proxyError ? true : undefined}>
                      <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
                      <FieldContent>
                        <form
                          className="w-full"
                          onSubmit={(event) => {
                            event.preventDefault();
                            saveProxy();
                          }}
                        >
                          <InputGroup>
                            <InputGroupInput
                              id="proxy"
                              type="text"
                              inputMode="url"
                              autoCapitalize="none"
                              value={proxyDraft}
                              onChange={(event) => {
                                setProxyDraft(event.target.value);
                                setProxyError(null);
                                setProxyStatus(null);
                              }}
                              placeholder="http://127.0.0.1:7890"
                              aria-invalid={proxyError ? true : undefined}
                            />
                            <InputGroupAddon align="inline-end">
                              <InputGroupButton type="submit" variant="secondary" size="sm">
                                保存
                              </InputGroupButton>
                            </InputGroupAddon>
                          </InputGroup>
                        </form>
                        <FieldDescription>
                          留空保存即关闭代理；省略协议时按 HTTP 处理。
                        </FieldDescription>
                        {proxyError ? (
                          <FieldError>{proxyError}</FieldError>
                        ) : (
                          proxyStatus && (
                            <FieldDescription role="status">{proxyStatus}</FieldDescription>
                          )
                        )}
                      </FieldContent>
                    </Field>
                  </Section>
                  <IptvCustomM3uUrlField />
                </div>
              </SettingsContent>
            </TabsContent>
          )}

          {category === "account" && (
            <TabsContent value="account" className="mt-0">
              <SettingsContent title="账号">
                <div className="flex flex-col gap-4">
                  <DanmakuSendField />
                  <AccountCard
                    siteId="bilibili"
                    title="哔哩哔哩"
                    description="用于登录态浏览；保存 Cookie 后首页会自动使用账号推荐，也可接收和发送弹幕。"
                    placeholder="SESSDATA=…; bili_jct=…"
                    qrLogin
                  />
                  <AccountCard
                    siteId="douyu"
                    title="斗鱼"
                    description="用于发送弹幕。"
                    placeholder="acf_username=…; acf_stk=…; acf_ltkid=…"
                    qrLogin
                  />
                  <AccountCard
                    siteId="huya"
                    title="虎牙"
                    description="用于发送弹幕；暂不支持扫码，请粘贴完整 Cookie。"
                    placeholder="yyuid=…; udb_uid=…; udb_n=…; udb_cred=…"
                  />
                  <AccountCard
                    siteId="douyin"
                    title="抖音"
                    description="用于登录态搜索和实时弹幕。"
                    placeholder="sessionid=…; ttwid=…; msToken=…"
                    qrLogin
                  />
                </div>
              </SettingsContent>
            </TabsContent>
          )}

          {category === "data" && (
            <TabsContent value="data" className="mt-0">
              <SettingsContent title="数据">
                <Section
                  title="导入 / 导出"
                  description="包含设置、关注、标签、历史和屏蔽词，不含 Cookie 和本机路径。"
                >
                  <Field data-invalid={profileError ? true : undefined}>
                    <FieldContent>
                      <FieldTitle>配置档案</FieldTitle>
                      <FieldDescription>通过系统文件选择器选取 JSON 档案。</FieldDescription>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Button
                          onClick={() => void chooseProfileForExport()}
                          disabled={profileAction !== null}
                        >
                          {profileAction === "export" ? (
                            <Spinner data-icon="inline-start" />
                          ) : (
                            <Download data-icon="inline-start" aria-hidden />
                          )}
                          {profileAction === "export" ? "正在导出…" : "导出配置"}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void chooseProfileForImport()}
                          disabled={profileAction !== null}
                        >
                          {profileAction === "import" ? (
                            <Spinner data-icon="inline-start" />
                          ) : (
                            <Upload data-icon="inline-start" aria-hidden />
                          )}
                          {profileAction === "import" ? "正在导入…" : "导入配置"}
                        </Button>
                      </div>
                      {profileError ? (
                        <FieldError>{profileError}</FieldError>
                      ) : (
                        profileStatus && (
                          <FieldDescription role="status" aria-live="polite">
                            {profileStatus}
                          </FieldDescription>
                        )
                      )}
                    </FieldContent>
                  </Field>
                </Section>
              </SettingsContent>
            </TabsContent>
          )}

          {category === "about" && (
            <TabsContent value="about" className="mt-0">
              <SettingsContent title="关于">
                <AboutSettings />
              </SettingsContent>
            </TabsContent>
          )}
        </div>
      </Tabs>
    </div>
  );
}

function SettingsContent({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold max-md:sr-only">{title}</h2>
      </div>
      {children}
    </section>
  );
}

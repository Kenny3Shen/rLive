import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  ExternalLink,
  Info,
  MonitorPlay,
  Network,
  Power,
  QrCode,
  Radio,
  RefreshCw,
  ShieldAlert,
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
import { SITE_LABELS } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

type CookieMethod = "manual" | "qr";

type AccountQrLoginStart = {
  qr_code_url: string;
  qr_key: string;
};

type AccountQrLoginPoll = {
  status: "pending" | "scanned" | "expired" | "success";
  message: string;
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
    <section className="rounded-2xl border border-border-subtle bg-card/60 p-4 md:p-5">
      <FieldSet>
        <FieldLegend variant="label">{title}</FieldLegend>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldGroup className="gap-3">{children}</FieldGroup>
      </FieldSet>
    </section>
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
            <p className="text-sm font-medium">使用手机扫码登录</p>
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
        <FieldDescription>
          扫码确认后会直接把登录 Cookie 保存到本机，不会显示或上传 Cookie 内容。
        </FieldDescription>
      </FieldContent>
    </Field>
  );
}

function CookieField({
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
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<CookieMethod>("manual");
  const inputId = `${siteId}-cookie`;

  const refreshCookieDependentQueries = useCallback(() => {
    // The Cookie write has already succeeded at this point. A failed network
    // refresh must not turn that successful account update into a UI error;
    // the affected query keeps its own error state and remains stale to retry.
    void invalidateCookieDependentSiteQueries(queryClient, siteId).catch(() => {});
  }, [queryClient, siteId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const value = await invokeCmd<string | null>("account_get_cookie", {
          siteId,
        });
        if (!cancelled) setCookie(value ?? "");
      } catch {
        if (!cancelled) setCookie("");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  async function saveCookie() {
    setStatus(null);
    try {
      const trimmed = cookie.trim();
      if (trimmed.length === 0) {
        await invokeCmd<void>("account_clear_cookie", { siteId });
        setCookie("");
        setStatus("Cookie 已清除");
      } else {
        await invokeCmd<void>("account_set_cookie", {
          siteId,
          cookie: trimmed,
        });
        setStatus("Cookie 已保存");
      }
      // A room composer can remain mounted while the account UI updates its
      // credentials. Notify it only after the backend mutation succeeds.
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
      refreshCookieDependentQueries();
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setStatus(`失败：${message}`);
    }
  }

  const loadQrCookie = useCallback(async () => {
    try {
      const value = await invokeCmd<string | null>("account_get_cookie", { siteId });
      setCookie(value ?? "");
      setStatus("Cookie 已通过扫码登录更新");
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
      refreshCookieDependentQueries();
    } catch {
      // The QR command has already saved successfully. A later display refresh
      // should not make that login look failed.
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
      refreshCookieDependentQueries();
    }
  }, [markDanmakuCookieChanged, refreshCookieDependentQueries, siteId]);

  return (
    <Section title={title} description={description}>
      {qrLogin && (
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle id={`${siteId}-cookie-method`}>获取方式</FieldTitle>
            <FieldDescription>
              选择扫码登录，或将浏览器中的 Cookie 手动粘贴到本机。
            </FieldDescription>
          </FieldContent>
          <ToggleGroup
            aria-labelledby={`${siteId}-cookie-method`}
            value={[method]}
            variant="outline"
            size="sm"
            spacing={1}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "manual" || next === "qr") setMethod(next);
            }}
          >
            <ToggleGroupItem value="qr">
              <QrCode data-icon="inline-start" aria-hidden />
              扫码登录
            </ToggleGroupItem>
            <ToggleGroupItem value="manual">手动输入</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      {method === "qr" && qrLogin ? (
        <QrLogin siteId={siteId} siteName={title} onSaved={loadQrCookie} />
      ) : (
        <Field>
          <FieldLabel htmlFor={inputId}>Cookie</FieldLabel>
          <FieldContent>
            <Textarea
              id={inputId}
              value={cookie}
              onChange={(event) => setCookie(event.target.value)}
              disabled={loading}
              rows={5}
              placeholder={loading ? "加载中…" : placeholder}
              className="resize-y font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex items-center gap-3">
              <Button onClick={() => void saveCookie()} disabled={loading}>
                保存 Cookie
              </Button>
              {status && <FieldDescription>{status}</FieldDescription>}
            </div>
          </FieldContent>
        </Field>
      )}
    </Section>
  );
}

function DanmakuSendField() {
  const enabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const setEnabled = useSettingsStore((s) => s.setDanmakuSendEnabled);

  return (
    <Section
      title="弹幕发送"
      description="默认关闭；开启后可同时使用 B站、斗鱼和虎牙的单条普通文本发送，不会自动重试或发送礼物。"
    >
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle id="danmaku-send-title">启用发送功能</FieldTitle>
          <FieldDescription>
            {
              "启用后仍需为每个平台保存有效 Cookie，并通过该平台的房间、文本、冷却和服务端校验；Cookie 缺失或无效时对应发送框会保持禁用。"
            }
          </FieldDescription>
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
    <Section
      title="IPTV 自定义 M3U"
      description="可选：保存你有权使用的自定义频道源，供 IPTV 页面加载。"
    >
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="iptv-custom-m3u-url">默认 M3U 地址</FieldLabel>
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
            地址仅保存在本机，不会随配置导入或导出。请确认频道来源、地区限制和内容授权。
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

function LocalWhisperModelField() {
  const asrModelPath = useSettingsStore((s) => s.asrModelPath);
  const setAsrModelPath = useSettingsStore((s) => s.setAsrModelPath);
  const [draft, setDraft] = useState(asrModelPath ?? "");
  const [modelStatus, setModelStatus] = useState<AsrModelStatus | null>(null);
  const [action, setAction] = useState<"status" | "load" | "default" | "unload" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(asrModelPath ?? "");
  }, [asrModelPath]);

  const refreshStatus = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  function savePath() {
    const next = draft.trim() || null;
    setAsrModelPath(next);
    setError(null);
    setNotice(next ? "本地模型路径已保存" : "本地模型路径已清除");
  }

  async function loadModel() {
    const path = draft.trim();
    if (!path) {
      setNotice(null);
      setError("请先填写本地 Whisper 模型文件路径");
      return;
    }

    setAction("load");
    setError(null);
    setNotice(null);
    try {
      const next = await invokeCmd<AsrModelStatus>("asr_model_load", { path });
      const loadedPath = next.path?.trim() || path;
      setModelStatus(next);
      setDraft(loadedPath);
      setAsrModelPath(loadedPath);
      setNotice("本地 Whisper 模型已加载，可在直播间开启实时字幕");
    } catch (cause) {
      const message =
        typeof cause === "object" && cause && "message" in cause
          ? String((cause as { message: string }).message)
          : String(cause);
      setError(`加载模型失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function loadDefaultModel() {
    setAction("default");
    setError(null);
    setNotice(null);
    try {
      const next = await invokeCmd<AsrModelStatus>("asr_model_load_default");
      setModelStatus(next);
      setNotice("内置 Whisper 模型已加载，可在直播间开启实时字幕");
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
      setNotice("本地 Whisper 模型已卸载；已保存的路径仍可下次直接加载");
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

  const loading = action === "load" || action === "default" || modelStatus?.loading === true;
  const statusLabel = modelStatus?.loading
    ? "正在加载"
    : modelStatus?.loaded
      ? modelStatus.bundled
        ? "内置模型已加载"
        : "自定义模型已加载"
      : "未加载";

  return (
    <Section
      title="本地 Whisper 字幕模型"
      description="仅用于直播间实时字幕，识别在本机 CPU 上通过 whisper-rs 完成，不会上传音频。默认模型已随安装包提供，按需加载。"
    >
      <Field>
        <FieldContent>
          <div className="flex flex-wrap items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldTitle>内置默认模型</FieldTitle>
              <FieldDescription>
                Whisper tiny Q5_1 · 多语言 · 约 31 MB。适合 CPU 优先的直播间实时字幕。
              </FieldDescription>
            </div>
            <Badge variant="secondary">随应用提供</Badge>
          </div>
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
              {action === "default" ? "正在加载…" : "加载内置模型"}
            </Button>
            <Badge variant={modelStatus?.loaded ? "secondary" : "outline"}>{statusLabel}</Badge>
          </div>
        </FieldContent>
      </Field>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="asr-model-path">自定义模型路径（可选）</FieldLabel>
        <FieldContent>
          <form
            className="w-full"
            onSubmit={(event) => {
              event.preventDefault();
              savePath();
            }}
          >
            <InputGroup>
              <InputGroupInput
                id="asr-model-path"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="D:\\models\\ggml-base.bin"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                disabled={loading}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton type="submit" variant="secondary" size="sm" disabled={loading}>
                  保存路径
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <FieldDescription>
            可替换为本机的 Whisper GGML `.bin` 模型。路径仅保存在当前设备，不会随配置导入或导出。
          </FieldDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void loadModel()} disabled={loading || action === "status"}>
              {action === "load" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <MonitorPlay data-icon="inline-start" aria-hidden />
              )}
              {action === "load" ? "正在加载…" : "加载自定义模型"}
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
              {action === "unload" ? "正在卸载…" : "卸载模型"}
            </Button>
            <Button variant="ghost" onClick={() => void refreshStatus()} disabled={action !== null}>
              {action === "status" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" aria-hidden />
              )}
              刷新状态
            </Button>
          </div>
          {modelStatus?.loaded && (
            <FieldDescription>
              当前加载：
              {modelStatus.bundled ? "内置 Whisper tiny Q5_1（多语言）" : modelStatus.path}
            </FieldDescription>
          )}
          {notice && (
            <FieldDescription role="status" aria-live="polite">
              {notice}
            </FieldDescription>
          )}
          {error && <FieldError>{error}</FieldError>}
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

function PlatformEnablementField() {
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const setSiteEnabled = useSettingsStore((s) => s.setSiteEnabled);
  const enabled = enabledSiteIds(disabledSiteIds);

  return (
    <Section
      title="直播平台"
      description="关闭后会从平台切换、首页、分类、搜索和房间入口中隐藏。至少保留一个平台。"
    >
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
                {isLastEnabled
                  ? "至少保留一个直播平台，不能关闭当前最后一项。"
                  : isEnabled
                    ? "已启用，会显示在直播发现和房间入口中。"
                    : "已关闭，不会显示在直播发现和房间入口中。"}
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
      <Section title="项目主页" description="获取源代码、版本动态和问题反馈渠道。">
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle id="project-homepage">GitHub</FieldTitle>
            <FieldDescription>{PROJECT_HOMEPAGE_URL}</FieldDescription>
          </FieldContent>
          <Button onClick={openProjectHomepage} variant="outline">
            <ExternalLink data-icon="inline-start" aria-hidden />
            打开 GitHub
          </Button>
        </Field>
      </Section>

      <AlertDialog>
        <Section title="免责声明" description="使用本应用前，请阅读其内容与第三方服务边界。">
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
                  查看免责声明
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
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState("");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("playback");

  useEffect(() => {
    void loadFromBackend();
  }, [loadFromBackend]);

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  async function saveProxy() {
    setProxyStatus(null);
    const next = proxyDraft.trim();
    setProxy(next.length === 0 ? null : next);
    setProxyStatus("代理已保存");
  }

  async function exportProfile() {
    setProfileStatus(null);
    const path = profilePath.trim();
    if (!path) {
      setProfileStatus("请填写导出路径");
      return;
    }
    try {
      await invokeCmd("profile_export", { path });
      setProfileStatus(`已导出到 ${path}`);
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setProfileStatus(`导出失败：${msg}`);
    }
  }

  async function importProfile() {
    setProfileStatus(null);
    const path = profilePath.trim();
    if (!path) {
      setProfileStatus("请填写导入路径");
      return;
    }
    try {
      const r = await invokeCmd<{
        follows: number;
        tags: number;
        history: number;
        settings: boolean;
      }>("profile_import", { path });
      setProfileStatus(`已导入 关注=${r.follows} 标签=${r.tags} 历史=${r.history}`);
      await loadFromBackend();
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setProfileStatus(`导入失败：${msg}`);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader title="设置" />

      <Tabs
        value={category}
        orientation="vertical"
        className="min-h-[32rem] max-md:flex-col"
        onValueChange={(value) => setCategory(value as SettingsCategory)}
      >
        <TabsList
          aria-label="设置分类"
          className="w-44 shrink-0 rounded-xl border border-border-subtle bg-card/60 p-1 max-md:w-full max-md:flex-row! max-md:overflow-x-auto"
        >
          {settingsCategories.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-11 shrink-0 gap-2 rounded-lg px-3 py-2 text-left"
            >
              <Icon aria-hidden />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-w-0 flex-1">
          <TabsContent value="playback" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="播放">
              <Section title="清晰度">
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldTitle id="quality-label">优先清晰度</FieldTitle>
                    <FieldDescription>有可用线路时优先选择此档。</FieldDescription>
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
              <LocalWhisperModelField />
            </SettingsContent>
          </TabsContent>

          <TabsContent value="platform" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="平台">
              <PlatformEnablementField />
            </SettingsContent>
          </TabsContent>

          <TabsContent value="network" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="网络">
              <div className="flex flex-col gap-4">
                <Section title="代理" description="可选 HTTP(S) 代理">
                  <Field>
                    <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
                    <FieldContent className="flex-row items-center gap-2">
                      <Input
                        id="proxy"
                        value={proxyDraft}
                        onChange={(event) => setProxyDraft(event.target.value)}
                        placeholder="http://127.0.0.1:7890"
                      />
                      <Button className="shrink-0" onClick={() => void saveProxy()}>
                        保存
                      </Button>
                    </FieldContent>
                    {proxyStatus && <FieldDescription>{proxyStatus}</FieldDescription>}
                  </Field>
                </Section>
                <IptvCustomM3uUrlField />
              </div>
            </SettingsContent>
          </TabsContent>

          <TabsContent value="account" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="账号">
              <div className="flex flex-col gap-4">
                <DanmakuSendField />
                <CookieField
                  siteId="bilibili"
                  title="哔哩哔哩"
                  description="支持官方二维码登录和手动 Cookie 输入；用于只读 API、接收弹幕和已启用的单条弹幕发送。"
                  placeholder="SESSDATA=…; bili_jct=…"
                  qrLogin
                />
                <CookieField
                  siteId="douyu"
                  title="斗鱼"
                  description="用于发送普通弹幕。支持扫码登录和手动 Cookie 输入。"
                  placeholder="acf_username=…; acf_stk=…; acf_ltkid=…"
                  qrLogin
                />
                <CookieField
                  siteId="huya"
                  title="虎牙"
                  description="用于发送普通弹幕；当前仅支持手动 Cookie 输入，暂不提供二维码登录。请粘贴完整 Cookie。"
                  placeholder="yyuid=…; udb_cred=…"
                />
                <CookieField
                  siteId="douyin"
                  title="抖音"
                  description="支持扫码登录和手动 Cookie 输入；可用于登录态搜索和实时弹幕连接。推荐和分类当前仅支持首屏，抖音仍可能要求网页访问验证。"
                  placeholder="sessionid=…; ttwid=…; msToken=…"
                  qrLogin
                />
              </div>
            </SettingsContent>
          </TabsContent>

          <TabsContent value="data" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="数据">
              <Section
                title="导入 / 导出"
                description="设置、关注、标签、历史和屏蔽词；不含 Cookie、自定义 M3U 地址、本机 Whisper 模型路径或本机发送授权。"
              >
                <Field>
                  <FieldLabel htmlFor="profile-path">文件路径</FieldLabel>
                  <FieldContent>
                    <Input
                      id="profile-path"
                      value={profilePath}
                      onChange={(event) => setProfilePath(event.target.value)}
                      placeholder="/tmp/rlive-profile.json"
                      className="font-mono text-xs"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => void exportProfile()}>导出</Button>
                      <Button variant="outline" onClick={() => void importProfile()}>
                        导入
                      </Button>
                    </div>
                    {profileStatus && <FieldDescription>{profileStatus}</FieldDescription>}
                  </FieldContent>
                </Field>
              </Section>
            </SettingsContent>
          </TabsContent>

          <TabsContent value="about" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="关于">
              <AboutSettings />
            </SettingsContent>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function SettingsContent({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

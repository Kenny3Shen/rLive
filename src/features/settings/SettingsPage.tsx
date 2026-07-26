import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Database, MonitorPlay, Network, QrCode, Radio, RefreshCw, UserRound } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { invokeCmd } from "@/shared/api/tauri";
import { enabledSiteIds, LIVE_SITE_IDS } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { PageHeader } from "@/shared/components/PageHeader";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { SITE_LABELS } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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

type SettingsCategory = "playback" | "platform" | "network" | "account" | "data";

type CookieMethod = "manual" | "qr";

type AccountQrLoginStart = {
  qr_code_url: string;
  qr_key: string;
};

type AccountQrLoginPoll = {
  status: "pending" | "scanned" | "expired" | "success";
  message: string;
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
];

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
  const markDanmakuCookieChanged = useSettingsStore((s) => s.markDanmakuCookieChanged);
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<CookieMethod>("manual");
  const inputId = `${siteId}-cookie`;

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
    } catch {
      // The QR command has already saved successfully. A later display refresh
      // should not make that login look failed.
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
    }
  }, [markDanmakuCookieChanged, siteId]);

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
            启用后仍需为每个平台保存有效 Cookie，并通过该平台的房间、文本、冷却和服务端校验；
            Cookie 缺失或无效时对应发送框会保持禁用。
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
                  description="支持扫码登录和手动 Cookie 输入；可用于搜索、提高房间解析可用性，并供固定本机实时弹幕签名服务创建会话。"
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
                description="设置、关注、标签、历史和屏蔽词；不含 Cookie、自定义 M3U 地址或本机发送授权。"
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

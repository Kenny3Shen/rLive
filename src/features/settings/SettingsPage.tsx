import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Database, MonitorPlay, Network, UserRound } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import type { SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { PageHeader } from "@/shared/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";

type SettingsCategory = "playback" | "network" | "account" | "data";

const settingsCategories: {
  value: SettingsCategory;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "playback", label: "播放", icon: MonitorPlay },
  { value: "network", label: "网络", icon: Network },
  { value: "account", label: "账号", icon: UserRound },
  { value: "data", label: "数据", icon: Database },
];

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

function CookieField({
  siteId,
  title,
  description,
  placeholder,
}: {
  siteId: SiteId;
  title: string;
  description: string;
  placeholder: string;
}) {
  const markBilibiliCookieChanged = useSettingsStore((s) => s.markBilibiliCookieChanged);
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
      if (siteId === "bilibili") markBilibiliCookieChanged();
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setStatus(`失败：${message}`);
    }
  }

  return (
    <Section title={title} description={description}>
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
    </Section>
  );
}

function BilibiliDanmakuSendField() {
  const enabled = useSettingsStore((s) => s.bilibiliDanmakuSendEnabled);
  const setEnabled = useSettingsStore((s) => s.setBilibiliDanmakuSendEnabled);

  return (
    <Section
      title="实验性：发送 B 站弹幕"
      description="灰度功能，默认关闭。仅支持用户逐条确认后发送普通滚动文本，不会自动重试或发送礼物。"
    >
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle id="bilibili-send-title">启用单条弹幕发送</FieldTitle>
          <FieldDescription>
            启用后仍需在房间内保存含 SESSDATA 与 bili_jct 的 Cookie；Cookie
            缺失或无效时发送框会保持禁用。
          </FieldDescription>
        </FieldContent>
        <Switch
          aria-labelledby="bilibili-send-title"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </Field>
    </Section>
  );
}

function DouyinDanmakuSignServiceField() {
  const signService = useSettingsStore((s) => s.douyinDanmakuSignService);
  const setSignService = useSettingsStore((s) => s.setDouyinDanmakuSignService);
  const [draft, setDraft] = useState(signService ?? "");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraft(signService ?? "");
  }, [signService]);

  function save() {
    const next = draft.trim();
    if (next && !isAllowedDouyinSignServiceUrl(next)) {
      setStatus("仅支持 HTTPS，或 localhost / 127.0.0.1 / ::1 的 HTTP 完整地址");
      return;
    }
    setSignService(next || null);
    setStatus(next ? "签名服务地址已保存" : "签名服务地址已清除");
  }

  return (
    <Section
      title="抖音实时弹幕"
      description="抖音 WebSocket 需要短时签名地址。请配置你自行运行或信任的签名服务完整端点。"
    >
      <Field>
        <FieldLabel htmlFor="douyin-danmaku-sign-service">签名服务地址</FieldLabel>
        <FieldContent>
          <div className="flex gap-2">
            <Input
              id="douyin-danmaku-sign-service"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="http://127.0.0.1:18080/sign"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
            />
            <Button className="shrink-0" onClick={save}>
              保存
            </Button>
          </div>
          <FieldDescription>
            为保护 Cookie，仅允许 HTTPS，或本机 localhost / 127.0.0.1 / ::1 的 HTTP
            服务。连接时会把已保存的抖音 Cookie 交给该服务生成签名。
          </FieldDescription>
          {status && <FieldDescription>{status}</FieldDescription>}
        </FieldContent>
      </Field>
    </Section>
  );
}

/** Match the backend's Cookie-safe signer endpoint policy before saving. */
function isAllowedDouyinSignServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
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

          <TabsContent value="network" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="网络">
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
            </SettingsContent>
          </TabsContent>

          <TabsContent value="account" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="账号">
              <div className="flex flex-col gap-4">
                <CookieField
                  siteId="bilibili"
                  title="哔哩哔哩"
                  description="用于只读 API、接收弹幕和可选的实验性单条发送；清空后保存即可删除。"
                  placeholder="SESSDATA=…; bili_jct=…"
                />
                <BilibiliDanmakuSendField />
                <CookieField
                  siteId="douyin"
                  title="抖音"
                  description="完整网页登录 Cookie 可用于搜索、提高房间解析可用性，并作为实时弹幕签名服务的会话输入。"
                  placeholder="sessionid=…; ttwid=…; msToken=…"
                />
                <DouyinDanmakuSignServiceField />
              </div>
            </SettingsContent>
          </TabsContent>

          <TabsContent value="data" keepMounted className="mt-0 data-[hidden]:hidden">
            <SettingsContent title="数据">
              <Section
                title="导入 / 导出"
                description="设置、关注、标签、历史和屏蔽词；不含 Cookie、抖音签名服务或实验性发送开关。"
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

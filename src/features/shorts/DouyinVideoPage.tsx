import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Play } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DouyinVideoPlayer } from "./DouyinVideoPlayer";
import { DouyinShortsFeed } from "./DouyinShortsFeed";

/** 推荐走共享沉浸舞台；作品链接保持独立输入，不预取推荐。 */
export function DouyinVideoPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const linkMode = searchParams.get("tab") === "link";
  const [revision, setRevision] = useState(0);
  return (
    <div data-slot="douyin-video-page" className="h-full min-h-0">
      {linkMode ? (
        <div className="h-full overflow-y-auto">
          <section className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
            <header className="flex flex-wrap items-center gap-3">
              <Link to="/shorts" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <ArrowLeft data-icon="inline-start" />B 站短视频
              </Link>
              <h1 className="text-lg font-semibold">抖音短视频</h1>
            </header>
            <p className="text-sm text-muted-foreground">
              推荐使用本机保存的抖音登录
              Cookie，不保证个性化效果，不绕过访问验证。暂不提供评论、点赞与观看历史。
            </p>
            <Link
              to="/settings?section=account"
              className={buttonVariants({ variant: "link", size: "sm", className: "self-start" })}
            >
              前往设置管理抖音账号
            </Link>
            <Tabs
              value="link"
              onValueChange={(value) => {
                if (value !== "recommend") return;
                setSearchParams(
                  (previous) => {
                    const next = new URLSearchParams(previous);
                    next.delete("tab");
                    return next;
                  },
                  { replace: true },
                );
              }}
            >
              <TabsList aria-label="抖音短视频浏览方式">
                <TabsTrigger value="recommend">推荐</TabsTrigger>
                <TabsTrigger value="link">作品链接</TabsTrigger>
              </TabsList>
              <TabsContent value="link">
                <DouyinVideoLinkForm />
              </TabsContent>
            </Tabs>
          </section>
        </div>
      ) : (
        <DouyinShortsFeed key={revision} onRefresh={() => setRevision((value) => value + 1)} />
      )}
    </div>
  );
}

function DouyinVideoLinkForm() {
  const [input, setInput] = useState("");
  const [request, setRequest] = useState<{ input: string; revision: number } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = input.trim();
          if (trimmed)
            setRequest((previous) => ({ input: trimmed, revision: (previous?.revision ?? 0) + 1 }));
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="douyin-video-input">作品链接或分享文字</FieldLabel>
            <Input
              id="douyin-video-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="粘贴抖音作品链接、分享文字或作品 ID"
              autoComplete="off"
              maxLength={4096}
              required
              aria-describedby="douyin-video-help"
            />
            <FieldDescription id="douyin-video-help">
              支持公开视频作品，不支持图集和直播。访问验证或作品不可见时无法播放。
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!input.trim()}>
              <Play data-icon="inline-start" />
              打开作品
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {request && <DouyinVideoPlayer key={request.revision} input={request.input} />}
    </div>
  );
}

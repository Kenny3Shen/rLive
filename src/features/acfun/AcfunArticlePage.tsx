import { useQuery } from "@tanstack/react-query";
import { Eye, MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { cn, formatOnline, normalizeVideoCoverUrl } from "@/lib/utils";
import { openExternalUrl } from "@/shared/externalUrl";
import { acfunArticleGetDetail } from "./acfunApi";
import {
  articleCoverForDisplay,
  articleHeadingLevel,
  articleSummaryForDisplay,
  safeHttpLink,
} from "./acfunArticleContent";
import type { AcfunArticleBlock, AcfunArticleInline } from "./acfunTypes";

const ARTICLE_LINK_CLASS =
  "break-words text-primary underline decoration-current/40 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";

function articleDate(timestamp: number): Date | null {
  if (!timestamp) return null;
  const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(timestamp: number): string {
  const date = articleDate(timestamp);
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function headingClass(level: number): string {
  if (level === 2) {
    return "mt-10 text-2xl leading-9 font-semibold tracking-tight first:mt-0 [overflow-wrap:anywhere] md:text-[1.75rem]";
  }
  if (level === 3) {
    return "mt-9 text-xl leading-8 font-semibold tracking-tight first:mt-0 [overflow-wrap:anywhere] md:text-2xl";
  }
  if (level === 4) {
    return "mt-8 text-lg leading-7 font-semibold first:mt-0 [overflow-wrap:anywhere] md:text-xl";
  }
  return "mt-7 text-base leading-7 font-semibold first:mt-0 [overflow-wrap:anywhere] md:text-lg";
}

function ArticleExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      rel="noreferrer"
      className={ARTICLE_LINK_CLASS}
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function ArticleInline({ inline }: { inline: AcfunArticleInline }) {
  let content: ReactNode = inline.text;
  if (inline.italic) content = <em>{content}</em>;
  if (inline.bold) content = <strong>{content}</strong>;
  if (inline.type === "link") {
    const href = safeHttpLink(inline.url);
    if (href) content = <ArticleExternalLink href={href}>{content}</ArticleExternalLink>;
  }
  return content;
}

function ArticleParagraph({ block }: { block: Extract<AcfunArticleBlock, { type: "paragraph" }> }) {
  return (
    <p className="mt-5 whitespace-pre-wrap first:mt-0 [overflow-wrap:anywhere]">
      {block.inlines?.length
        ? block.inlines.map((inline, index) => (
            <ArticleInline key={`${index}:${inline.text}`} inline={inline} />
          ))
        : block.text}
    </p>
  );
}

function ArticleBlock({ block }: { block: AcfunArticleBlock }) {
  switch (block.type) {
    case "paragraph":
      return <ArticleParagraph block={block} />;
    case "heading": {
      const level = articleHeadingLevel(block.level);
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className={headingClass(level)}>{block.text}</Tag>;
    }
    case "image": {
      const src = normalizeVideoCoverUrl(block.url);
      if (!src) return null;
      return (
        <figure className="mt-6 flex flex-col items-center gap-2 first:mt-0">
          <img
            src={src}
            alt={block.alt ?? ""}
            loading="lazy"
            decoding="async"
            className="block h-auto max-w-full rounded-lg object-contain ring-1 ring-border-subtle"
          />
          {block.alt && (
            <figcaption className="max-w-2xl text-center text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              {block.alt}
            </figcaption>
          )}
        </figure>
      );
    }
    case "link": {
      const href = safeHttpLink(block.url);
      return (
        <p className="mt-5 first:mt-0 [overflow-wrap:anywhere]">
          {href ? <ArticleExternalLink href={href}>{block.text}</ArticleExternalLink> : block.text}
        </p>
      );
    }
    case "quote":
      return (
        <blockquote className="mt-6 whitespace-pre-wrap border-l-4 border-primary/70 bg-muted/45 px-4 py-3 text-muted-foreground first:mt-0 [overflow-wrap:anywhere]">
          {block.text}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={cn(
            "mt-5 flex flex-col gap-2 pl-6 first:mt-0",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, index) => (
            <li
              key={`${index}:${item}`}
              className="whitespace-pre-wrap pl-1 [overflow-wrap:anywhere]"
            >
              {item}
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre className="mt-6 max-w-full overflow-x-auto rounded-lg bg-muted p-4 text-sm leading-6 first:mt-0 md:text-base md:leading-7">
          <code className="whitespace-pre">{block.text}</code>
        </pre>
      );
    case "divider":
      return <Separator className="mt-8 first:mt-0" />;
  }
}

function ArticleSkeleton() {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col pt-12 pb-12">
      <header className="flex flex-col gap-4 pb-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-12 w-4/5" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-11 w-full" />
      </header>
      <Separator />
      <div className="flex flex-col gap-5 pt-7">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-11/12" />
        <Skeleton className="h-44 w-full rounded-lg" />
        <Skeleton className="h-5 w-4/5" />
      </div>
    </article>
  );
}

export function AcfunArticlePage() {
  const { articleId = "" } = useParams<{ articleId: string }>();
  const query = useQuery({
    queryKey: ["acfun_article", articleId],
    queryFn: () => acfunArticleGetDetail(articleId),
    enabled: articleId.length > 0,
    staleTime: 5 * 60_000,
  });

  if (query.isLoading) {
    return <ArticleSkeleton />;
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col pt-12 pb-12">
        <ErrorState
          className="mt-2"
          error={query.error ?? new Error("文章内容为空")}
          title="文章加载失败"
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const { item, blocks, tags } = query.data;
  const cover = articleCoverForDisplay(item.cover, blocks);
  const coverSrc = normalizeVideoCoverUrl(cover ?? "");
  const summary = articleSummaryForDisplay(item.title, item.summary, blocks);
  const published = dateText(item.published_at);
  const publishedIso = articleDate(item.published_at)?.toISOString();

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col pt-12 pb-12">
      <header className="flex flex-col gap-4 pb-6">
        {item.channel_name && (
          <Badge variant="outline" className="max-w-full truncate" title={item.channel_name}>
            {item.channel_name}
          </Badge>
        )}
        <h1 className="text-3xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere] md:text-4xl">
          {item.title}
        </h1>
        {summary && (
          <p className="text-base leading-7 text-muted-foreground [overflow-wrap:anywhere]">
            {summary}
          </p>
        )}
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border-subtle py-3 text-sm text-muted-foreground">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="shrink-0 font-medium text-foreground">作者</dt>
            <dd className="min-w-0 truncate">{item.author || "未知作者"}</dd>
          </div>
          {published && publishedIso && (
            <div className="flex items-baseline gap-1.5">
              <dt className="font-medium text-foreground">发布</dt>
              <dd>
                <time dateTime={publishedIso}>{published}</time>
              </dd>
            </div>
          )}
          <div className="flex items-center gap-1.5 tabular-nums">
            <dt className="font-medium text-foreground">阅读</dt>
            <dd className="inline-flex items-center gap-1">
              <Eye className="size-4" data-icon="inline-start" aria-hidden />
              {formatOnline(item.view_count)}
            </dd>
          </div>
          <div className="flex items-center gap-1.5 tabular-nums">
            <dt className="font-medium text-foreground">评论</dt>
            <dd className="inline-flex items-center gap-1">
              <MessageCircle className="size-4" data-icon="inline-start" aria-hidden />
              {formatOnline(item.comment_count)}
            </dd>
          </div>
        </dl>
      </header>

      {coverSrc && (
        <figure className="mb-8 flex flex-col items-center">
          <img
            src={coverSrc}
            alt=""
            loading="eager"
            decoding="async"
            className="block h-auto max-h-[68vh] max-w-full rounded-xl object-contain ring-1 ring-border-subtle"
          />
        </figure>
      )}

      <div className="text-base leading-8 md:text-[17px] md:leading-[1.9]">
        {blocks.map((block, index) => (
          <ArticleBlock key={index} block={block} />
        ))}
      </div>

      {tags.length > 0 && (
        <footer className="mt-10 flex flex-col gap-3">
          <Separator />
          <h2 className="pt-2 text-base font-semibold">文章标签</h2>
          <div className="flex flex-wrap gap-2" aria-label="文章标签">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="max-w-full truncate" title={tag}>
                {tag}
              </Badge>
            ))}
          </div>
        </footer>
      )}
    </article>
  );
}

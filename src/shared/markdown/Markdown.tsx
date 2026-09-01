import { type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";

// 更新说明等富文本统一走该组件：默认不渲染原始 HTML，
// 仅允许 Markdown 语法，链接通过 opener 插件在系统浏览器打开。
function openExternalLink(url: string): void {
  void openUrl(url).catch(() => {
    // 浏览器开发预览没有原生 opener 插件，退回 window.open。
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!href) return;
        event.preventDefault();
        openExternalLink(href);
      }}
    >
      {children}
    </a>
  );
}

// react-markdown 会给每个组件传入 hast node，展开到 DOM 元素会触发
// React 未知属性告警，这里统一剥离。
const components: Components = {
  h1: ({ node, ...props }) => <h1 className="text-base font-semibold text-foreground" {...props} />,
  h2: ({ node, ...props }) => <h2 className="text-sm font-semibold text-foreground" {...props} />,
  h3: ({ node, ...props }) => (
    <h3 className="text-[0.8125rem] font-semibold text-foreground" {...props} />
  ),
  h4: ({ node, ...props }) => <h4 className="text-sm font-medium text-foreground" {...props} />,
  p: ({ node, ...props }) => <p className="leading-relaxed" {...props} />,
  ul: ({ node, ...props }) => (
    <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground/80" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground/80" {...props} />
  ),
  li: ({ node, ...props }) => <li className="leading-relaxed [&>ol]:mt-1 [&>ul]:mt-1" {...props} />,
  a: ({ node, ...props }) => <MarkdownLink {...props} />,
  code: ({ node, ...props }) => (
    <code
      className="rounded-md bg-muted px-1.5 py-px font-mono text-[0.85em] text-foreground"
      {...props}
    />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="overflow-x-auto rounded-lg border border-border-subtle bg-muted/40 p-2.5 font-mono text-xs text-muted-foreground [&>code]:rounded-none [&>code]:bg-transparent [&>code]:px-0 [&>code]:py-0 [&>code]:text-inherit [&>code]:font-normal"
      {...props}
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote className="flex flex-col gap-2 border-l-2 border-border-subtle pl-3" {...props} />
  ),
  hr: ({ node, ...props }) => <hr className="border-0 border-t border-border-subtle" {...props} />,
  img: ({ node, ...props }) => (
    <img
      loading="lazy"
      className="inline-block max-h-48 max-w-full rounded-md border border-border-subtle"
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <table className="w-full border-collapse text-left text-[0.8125rem]" {...props} />
  ),
  th: ({ node, ...props }) => (
    <th className="border-b border-border-subtle px-2 py-1 font-semibold" {...props} />
  ),
  td: ({ node, ...props }) => (
    <td className="border-b border-border-subtle/50 px-2 py-1 align-top" {...props} />
  ),
};

export function Markdown({ className, children }: { className?: string; children: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)} data-slot="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

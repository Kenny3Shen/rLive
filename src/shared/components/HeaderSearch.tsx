import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Top-right search control for the main shell header.
 * Collapsed: icon button. Expanded / on /search: inline field.
 */
export function HeaderSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === "/search";
  const qFromUrl = onSearchPage ? (params.get("q") ?? "") : "";

  const [open, setOpen] = useState(onSearchPage);
  const [value, setValue] = useState(qFromUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onSearchPage) {
      setOpen(true);
      setValue(qFromUrl);
    }
  }, [onSearchPage, qFromUrl]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  function submit(next: string) {
    const q = next.trim();
    if (q.length === 0) {
      navigate("/search");
      return;
    }
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(value);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-ring"
        title="搜索"
        aria-label="搜索直播间"
      >
        <Search className="h-[18px] w-[18px]" />
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-full border border-border-subtle bg-card/90 pl-3 pr-1 shadow-sm backdrop-blur-sm",
        "w-[min(100%,220px)] sm:w-[260px]",
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (!onSearchPage) {
              setOpen(false);
              setValue("");
            }
          }
        }}
        placeholder="搜索直播间…"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        aria-label="搜索直播间"
      />
      {(value.length > 0 || !onSearchPage) && (
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          title={value.length > 0 ? "清除" : "收起"}
          aria-label={value.length > 0 ? "清除" : "收起搜索"}
          onClick={() => {
            if (value.length > 0) {
              setValue("");
              if (onSearchPage) navigate("/search");
              inputRef.current?.focus();
            } else if (!onSearchPage) {
              setOpen(false);
            }
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </form>
  );
}

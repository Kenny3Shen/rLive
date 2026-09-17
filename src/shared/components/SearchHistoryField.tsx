import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  addSearchHistoryEntry,
  readSearchHistory,
  removeSearchHistoryEntry,
  writeSearchHistory,
} from "@/shared/searchHistory";

/**
 * 带「搜索历史」下拉的查询字段，直播搜索页与视频搜索条共用。
 *
 * 关键词仍由调用方受控（`value`/`onValueChange`，通常与 URL 对齐），本组件只管
 * 历史记忆与下拉的开合：提交（表单或点历史项）时把词并入历史再回调 `onSubmit`，
 * 下拉只在**尚未提交关键词**（`committedKeyword` 为空）时弹出，绝不盖住结果卡片。
 *
 * `children` 渲染在输入组之后、表单之内，用来放提交按钮或范围下拉——两个搜索
 * 表面各自的额外控件因此不必复制这套浮层逻辑。
 */
export type SearchHistoryFieldProps = {
  /** localStorage 键；直播与视频各持一份，互不污染。 */
  historyKey: string;
  value: string;
  onValueChange: (value: string) => void;
  /** 提交或点历史项时回调，参数已去首尾空白；历史已在本组件内落盘。 */
  onSubmit: (keyword: string) => void;
  /** 已提交进 URL 的关键词，用来判断空态（决定历史下拉是否弹出）。 */
  committedKeyword: string;
  placeholder?: string;
  ariaLabel: string;
  /** 空态自动聚焦（空搜索页进入即可开打）。 */
  autoFocusWhenEmpty?: boolean;
  className?: string;
  inputGroupClassName?: string;
  /** 渲染在输入组**内部**末尾的控件（如内联提交按钮）。 */
  endAdornment?: ReactNode;
  /** 渲染在输入组之后、表单之内的额外控件（提交按钮 / 范围下拉）。 */
  children?: ReactNode;
};

export function SearchHistoryField({
  historyKey,
  value,
  onValueChange,
  onSubmit,
  committedKeyword,
  placeholder,
  ariaLabel,
  autoFocusWhenEmpty = false,
  className,
  inputGroupClassName,
  endAdornment,
  children,
}: SearchHistoryFieldProps) {
  const [history, setHistory] = useState<string[]>(() => readSearchHistory(historyKey));
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const historyPanelId = useId();

  // 空态进入（或返回/前进回到空搜索页）自动聚焦，直接开打关键词。
  useEffect(() => {
    if (autoFocusWhenEmpty && !committedKeyword) inputRef.current?.focus();
  }, [autoFocusWhenEmpty, committedKeyword]);

  const commitHistory = (keyword: string) => {
    const updated = addSearchHistoryEntry(history, keyword);
    writeSearchHistory(historyKey, updated);
    setHistory(updated);
    setShowHistory(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    commitHistory(trimmed);
    onSubmit(trimmed);
  };

  const handleHistoryClick = (item: string) => {
    onValueChange(item);
    setShowHistory(false);
    onSubmit(item);
  };

  const handleClearHistory = () => {
    writeSearchHistory(historyKey, []);
    setHistory([]);
  };

  // 删除单条后下拉保持展开，便于连续清理；删空后由 history.length 条件自动收起。
  const handleRemoveHistoryItem = (item: string) => {
    const updated = removeSearchHistoryEntry(history, item);
    writeSearchHistory(historyKey, updated);
    setHistory(updated);
  };

  // 只在空态（尚未出结果）弹出，绝不会盖住结果卡片。
  const historyOpen = showHistory && history.length > 0 && !committedKeyword;

  return (
    <form onSubmit={handleSubmit} className={cn("flex min-w-0 items-center gap-2", className)}>
      <Popover
        open={historyOpen}
        // 输入框自己就是 trigger：不套 PopoverTrigger —— 它的 useButton 会给
        // 容器盖上 role="button"，而 button 里裹 textbox 是坏语义。用 triggerId
        // 登记，否则受控 popup 停在 data-starting-style 上永远不过渡进场。
        triggerId={inputId}
        onOpenChange={(next, details) => {
          if (next) return;
          // 焦点始终留在输入框（浮层之外），Base UI 因此把两件事误判成关闭：
          // 点输入框挪光标算 outside press，聚焦输入框算 focus out。
          // 只要事件仍落在这块字段里就不是真的离开，否则光标一点历史就没了。
          const stillInField =
            details.reason === "outside-press" || details.reason === "focus-out"
              ? details.event.target instanceof Node &&
                (fieldRef.current?.contains(details.event.target) ||
                  fieldRef.current?.contains(document.activeElement))
              : false;
          if (stillInField) return;
          setShowHistory(false);
        }}
      >
        <InputGroup ref={fieldRef} className={cn("min-w-0 flex-1", inputGroupClassName)}>
          <InputGroupInput
            id={inputId}
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onFocus={() => setShowHistory(true)}
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={historyOpen}
            aria-controls={historyOpen ? historyPanelId : undefined}
            autoComplete="off"
          />
          {value && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="清除输入"
                onClick={() => {
                  onValueChange("");
                  inputRef.current?.focus();
                }}
              >
                <X aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          )}
          {endAdornment && <InputGroupAddon align="inline-end">{endAdornment}</InputGroupAddon>}
        </InputGroup>
        {/* 焦点留在输入框：下拉是提示而非取值控件，开合都不该打断打字。 */}
        <PopoverContent
          id={historyPanelId}
          anchor={fieldRef}
          align="start"
          aria-label="搜索历史"
          initialFocus={false}
          finalFocus={false}
          className="w-(--anchor-width) gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">搜索历史</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={handleClearHistory}
              className="h-auto p-0 text-xs"
            >
              清空
            </Button>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {history.map((item) => (
              <div key={item} className="flex items-center gap-1 px-3 py-2 hover:bg-muted">
                <button
                  type="button"
                  onClick={() => handleHistoryClick(item)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                >
                  <Search className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="flex-1 truncate">{item}</span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`删除搜索历史“${item}”`}
                  onClick={() => handleRemoveHistoryItem(item)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {children}
    </form>
  );
}

import { useState } from "react";
import { ChevronDown, ChevronUp, LayoutGrid } from "lucide-react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useAndroidBackClose } from "@/shared/hooks/useAndroidBackClose";
import type { LiveCategory, LiveSubCategory } from "@/shared/types/live";
import { cn, normalizeImageUrl } from "@/lib/utils";
import { categoryChipKey, categoryEntriesOf } from "./categorySelection";

/** 每个父分区默认铺开的磁贴数，其余折叠在「显示全部」之后。 */
export const INITIAL_CATEGORY_COUNT = 12;

type CategoryTileProps = {
  category: LiveSubCategory;
  selected: boolean;
  onClick: () => void;
};

export function CategoryTile({ category, selected, onClick }: CategoryTileProps) {
  const iconSrc = normalizeImageUrl(category.pic);

  return (
    <button
      type="button"
      data-motion-press
      title={`查看${category.name}`}
      aria-current={selected ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "group flex w-full max-w-24 flex-col items-center gap-2 rounded-xl px-1 py-1.5 text-center transition-colors focus-ring",
        selected ? "bg-secondary text-foreground" : "text-foreground hover:bg-muted/65",
      )}
    >
      <span
        className={cn(
          "relative flex size-10 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1",
          selected ? "ring-primary" : "ring-border-subtle",
        )}
      >
        <LayoutGrid className="size-5 text-muted-foreground" aria-hidden />
        {iconSrc && (
          <img
            src={iconSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </span>
      <span className="line-clamp-2 min-h-8 text-xs leading-4 font-medium">{category.name}</span>
    </button>
  );
}

type ExpandTileProps = {
  expanded: boolean;
  onClick: () => void;
};

export function ExpandTile({ expanded, onClick }: ExpandTileProps) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-motion-press
      onClick={onClick}
      className="group flex w-full max-w-24 flex-col items-center gap-2 rounded-xl px-1 py-1.5 text-center text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground focus-ring"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted ring-1 ring-border-subtle transition-colors group-hover:bg-sidebar-active">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-h-8 text-xs leading-4 font-medium">
        {expanded ? "收起" : "显示全部"}
      </span>
    </button>
  );
}

type CategoryGroupsProps = {
  categories: readonly LiveCategory[];
  /** 当前选中分区的 chip key，用于在面板里回显选择。 */
  selectedKey: string | null;
  onSelect: (category: LiveSubCategory) => void;
};

/**
 * 分组磁贴列表本体（父分区标题 + 磁贴网格 + 每组的展开/收起）。
 *
 * 与外层容器分离：桌面的独立分类页与移动端抽屉是两种呈现，但里面必须是同一份
 * 内容，否则两个表面会各自漂移出不同的分组规则。
 */
export function CategoryGroups({ categories, selectedKey, onSelect }: CategoryGroupsProps) {
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set());

  function toggleParent(parentId: string) {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-9">
      {categories.map((parent) => {
        const expanded = expandedParents.has(parent.id);
        // 条带与面板共用同一条「该不该出聚合项」的规则，否则两个表面会各自漂移。
        const children = categoryEntriesOf(categories, parent);
        const visibleChildren = expanded ? children : children.slice(0, INITIAL_CATEGORY_COUNT);
        const canExpand = children.length > INITIAL_CATEGORY_COUNT;

        return (
          <section key={parent.id} aria-labelledby={`category-${parent.id}`}>
            <h2
              id={`category-${parent.id}`}
              className="mb-4 text-xl font-semibold tracking-tight text-foreground max-md:mb-3 max-md:text-base"
            >
              {parent.name}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(74px,1fr))] justify-items-center gap-x-5 gap-y-4">
              {visibleChildren.map((child) => (
                <CategoryTile
                  key={child.id}
                  category={child}
                  selected={categoryChipKey(child.parent_id, child.id) === selectedKey}
                  onClick={() => onSelect(child)}
                />
              ))}
              {canExpand && (
                <ExpandTile expanded={expanded} onClick={() => toggleParent(parent.id)} />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type CategoryPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: readonly LiveCategory[];
  /** 当前平台标识。仅用于在换平台时重置各组的展开态，见下方 `key`。 */
  treeKey: string;
  selectedKey: string | null;
  onSelect: (category: LiveSubCategory) => void;
};

/**
 * 「全部分类」的完整分区面板。
 *
 * 只服务触摸客户端。底部抽屉要拇指可达、要接系统返回键，这些都是触摸客户端的
 * 属性；桌面端不共用这套呈现，它跳到独立的 `/category` 页 —— 一屏几百个分区
 * 铺在首页内容栏里会把房间网格挤到折叠之下，而桌面本来就有完整的返回栈可用。
 */
export function CategoryPanel({
  open,
  onOpenChange,
  categories,
  treeKey,
  selectedKey,
  onSelect,
}: CategoryPanelProps) {
  // 按一次 Android Back 先收起面板，而不是离开首页。
  useAndroidBackClose(open, () => onOpenChange(false));

  function select(category: LiveSubCategory) {
    onOpenChange(false);
    onSelect(category);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[80dvh]">
        <DrawerTitle>全部分类</DrawerTitle>
        <div className="mt-3">
          {/* 换平台就换掉整棵分类树，上一平台展开过的父分区 id 在新树里没有意义。
              用 key 丢弃子树状态，而不是在副作用里补一次 setState。 */}
          <CategoryGroups
            key={treeKey}
            categories={categories}
            selectedKey={selectedKey}
            onSelect={select}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

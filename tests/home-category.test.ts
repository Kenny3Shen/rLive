import { describe, expect, test } from "bun:test";
import {
  CATEGORY_BROWSE_PATH,
  CATEGORY_CHIP_LIMIT,
  CATEGORY_PARAM,
  CATEGORY_PUSH_STATE,
  allCategoryOf,
  categoryBrowsePath,
  categoryChipKey,
  categoryChips,
  categoryNavigationIntent,
  encodeCategorySelection,
  hasHiddenCategories,
  homeCategoryPath,
  isCategoryPushEntry,
  parseCategorySelection,
  resolveSelectedCategory,
} from "../src/features/category/categorySelection";
import type { CategorySelection } from "../src/features/category/categorySelection";
import type { LiveCategory } from "../src/shared/types/live";

function child(parentId: string, id: string, name: string) {
  return { id, name, parent_id: parentId, pic: null };
}

const multiParent: LiveCategory[] = [
  {
    id: "1",
    name: "网游",
    children: [child("1", "101", "英雄联盟"), child("1", "102", "无畏契约")],
  },
  {
    id: "2",
    name: "手游",
    children: [child("2", "101,2", "和平精英"), child("2", "202", "原神")],
  },
  {
    id: "3",
    name: "娱乐",
    children: [child("3", "301", "户外")],
  },
];

const singleParent: LiveCategory[] = [
  {
    id: "9",
    name: "热门分类",
    children: Array.from({ length: 20 }, (_, index) =>
      child("9", `c${index}`, `分类${index}`),
    ),
  },
];

describe("category selection encoding", () => {
  test("round-trips a selection whose category id contains a comma", () => {
    const selection: CategorySelection = {
      siteId: "douyin",
      parentId: "7",
      categoryId: "101,2",
    };

    const encoded = encodeCategorySelection(selection);
    expect(encoded).toBe("douyin:7:101,2");
    expect(parseCategorySelection(encoded, "douyin")).toEqual(selection);
  });

  test("round-trips a uuid parent id", () => {
    // Twitch 的父分区是游戏类型标签的 UUID，比其他平台的数字 id 长且带连字符。
    const selection = {
      siteId: "twitch",
      parentId: "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3",
      categoryId: "valorant",
    } as const;
    expect(parseCategorySelection(encodeCategorySelection(selection), "twitch")).toEqual(selection);
  });

  test("keeps colons inside the trailing category id", () => {
    expect(parseCategorySelection("bilibili:1:a:b", "bilibili")).toEqual({
      siteId: "bilibili",
      parentId: "1",
      categoryId: "a:b",
    });
  });

  test("only the owning platform panel claims the parameter", () => {
    expect(parseCategorySelection("douyin:7:101,2", "bilibili")).toBeNull();
    expect(parseCategorySelection("douyin:7:101,2", "douyin")).not.toBeNull();
  });

  test("rejects unknown platforms, missing segments, and empty input", () => {
    expect(parseCategorySelection("kick:7:101", "bilibili")).toBeNull();
    expect(parseCategorySelection("bilibili:7", "bilibili")).toBeNull();
    expect(parseCategorySelection("bilibili", "bilibili")).toBeNull();
    expect(parseCategorySelection("bilibili:7:", "bilibili")).toBeNull();
    expect(parseCategorySelection("bilibili::101", "bilibili")).toBeNull();
    expect(parseCategorySelection(":7:101", "bilibili")).toBeNull();
    expect(parseCategorySelection("", "bilibili")).toBeNull();
    expect(parseCategorySelection(null, "bilibili")).toBeNull();
  });

  test("builds the home url with and without a selection", () => {
    expect(homeCategoryPath(null)).toBe("/");

    const path = homeCategoryPath({ siteId: "douyin", parentId: "7", categoryId: "101,2" });
    const url = new URL(path, "https://rlive.local");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get(CATEGORY_PARAM)).toBe("douyin:7:101,2");
  });

  test("carries the current selection into the desktop category page for read-back", () => {
    expect(categoryBrowsePath(null)).toBe(CATEGORY_BROWSE_PATH);

    const path = categoryBrowsePath({ siteId: "douyin", parentId: "7", categoryId: "101,2" });
    const url = new URL(path, "https://rlive.local");
    expect(url.pathname).toBe(CATEGORY_BROWSE_PATH);
    // 与首页共用同一个参数名，两个表面对分区身份只有一种写法。
    expect(url.searchParams.get(CATEGORY_PARAM)).toBe("douyin:7:101,2");
    expect(parseCategorySelection(url.searchParams.get(CATEGORY_PARAM), "douyin")).toEqual({
      siteId: "douyin",
      parentId: "7",
      categoryId: "101,2",
    });
  });
});

describe("category chips flattening", () => {
  test("emits one aggregate chip per parent when several parents exist", () => {
    const chips = categoryChips(multiParent, null);

    // 条带标签取父分区名。聚合项的 `category.name` 仍是「全部网游」——
    // 那个名字给展开面板里紧贴分组标题的那一格用，条带上前缀纯属复读。
    expect(chips.map((chip) => chip.label)).toEqual(["网游", "手游", "娱乐"]);
    expect(chips.map((chip) => chip.category.name)).toEqual(["全部网游", "全部手游", "全部娱乐"]);
    expect(chips.map((chip) => chip.key)).toEqual(["1:0", "2:0", "3:0"]);
    expect(chips.every((chip) => chip.category.id === "0")).toBe(true);
  });

  test("truncates children to the chip limit for a single-parent platform", () => {
    const chips = categoryChips(singleParent, null);

    // 不合成聚合项：单父分区的「全部X」就是全站，与组件自带的「推荐」重叠（后端
    // 对 id "0" 直接转给推荐接口）。条带因此从第一个真子分类开始。
    expect(chips).toHaveLength(CATEGORY_CHIP_LIMIT);
    expect(chips.every((chip) => chip.category.id !== "0")).toBe(true);
    expect(chips[0]!.label).toBe("分类0");
    expect(chips.at(-1)!.label).toBe(`分类${CATEGORY_CHIP_LIMIT - 1}`);
  });

  test("inserts a deep selection right after its parent chip", () => {
    const chips = categoryChips(multiParent, {
      siteId: "douyin",
      parentId: "2",
      categoryId: "202",
    });

    expect(chips.map((chip) => chip.key)).toEqual(["1:0", "2:0", "2:202", "3:0"]);
    expect(chips[2]!.label).toBe("原神");
  });

  test("does not insert anything when the selection is already visible", () => {
    const chips = categoryChips(multiParent, {
      siteId: "douyin",
      parentId: "2",
      categoryId: "0",
    });

    expect(chips).toHaveLength(3);
  });

  test("ignores an unresolvable selection instead of faking a chip", () => {
    const chips = categoryChips(multiParent, {
      siteId: "douyin",
      parentId: "99",
      categoryId: "999",
    });

    expect(chips.map((chip) => chip.key)).toEqual(["1:0", "2:0", "3:0"]);
  });

  test("reuses a parent's own id 0 child instead of synthesising a duplicate", () => {
    const withOwnAll: LiveCategory[] = [
      {
        id: "1",
        name: "网游",
        children: [child("1", "0", "网游全部"), child("1", "101", "英雄联盟")],
      },
      multiParent[1]!,
    ];

    // 后端自带的 id "0" 子项被复用（key 仍是 `1:0`，不合成重复项），但条带标签
    // 一律取父分区名：上游那个名字的语序不受我们控制（这里是「网游全部」），
    // 裁前缀裁不掉，取父名才对所有平台都成立。
    const chips = categoryChips(withOwnAll, null);
    expect(chips.map((chip) => chip.key)).toEqual(["1:0", "2:0"]);
    expect(chips.map((chip) => chip.label)).toEqual(["网游", "手游"]);
    expect(chips[0]!.category.name).toBe("网游全部");

    const single = categoryChips([withOwnAll[0]!], null);
    expect(single.map((chip) => chip.label)).toEqual(["网游", "英雄联盟"]);
  });

  test("returns nothing before the category tree is loaded", () => {
    expect(categoryChips([], null)).toEqual([]);
  });

  test("derives chip keys from parent and category ids", () => {
    expect(categoryChipKey("2", "101,2")).toBe("2:101,2");
  });

  test("marks aggregate entries so the bar can separate them from deep children", () => {
    expect(categoryChips(multiParent, null).every((chip) => chip.aggregate)).toBe(true);

    const withDeep = categoryChips(multiParent, {
      siteId: "douyin",
      parentId: "2",
      categoryId: "202",
    });
    expect(withDeep.map((chip) => chip.aggregate)).toEqual([true, true, false, true]);
  });
});

describe("hidden category detection", () => {
  test("reports hidden categories whenever chips are aggregate-only", () => {
    expect(hasHiddenCategories(multiParent)).toBe(true);
  });

  test("compares against the chip limit for a single-parent platform", () => {
    expect(hasHiddenCategories(singleParent)).toBe(true);

    const short: LiveCategory[] = [
      { id: "9", name: "热门分类", children: [child("9", "c0", "分类0")] },
    ];
    expect(hasHiddenCategories(short)).toBe(false);
  });

  test("stays false before the category tree loads and for empty parents", () => {
    expect(hasHiddenCategories([])).toBe(false);
    expect(
      hasHiddenCategories([
        { id: "1", name: "网游", children: [] },
        { id: "2", name: "手游", children: [] },
      ]),
    ).toBe(false);
  });
});

describe("category history intent", () => {
  const bili: CategorySelection = { siteId: "bilibili", parentId: "1", categoryId: "101" };
  const other: CategorySelection = { siteId: "bilibili", parentId: "2", categoryId: "202" };

  test("pushes when leaving the recommendation feed", () => {
    expect(categoryNavigationIntent(null, bili, null)).toEqual({
      kind: "push",
      path: homeCategoryPath(bili),
    });
  });

  test("replaces when swapping between categories", () => {
    expect(categoryNavigationIntent(bili, other, CATEGORY_PUSH_STATE)).toEqual({
      kind: "replace",
      path: homeCategoryPath(other),
    });
  });

  test("goes back to recommendations only when this page pushed the entry", () => {
    expect(categoryNavigationIntent(bili, null, CATEGORY_PUSH_STATE)).toEqual({ kind: "back" });
    expect(categoryNavigationIntent(bili, null, null)).toEqual({ kind: "replace", path: "/" });
  });

  test("treats a no-op selection as a same-path replace", () => {
    expect(categoryNavigationIntent(bili, { ...bili }, CATEGORY_PUSH_STATE)).toEqual({
      kind: "replace",
      path: homeCategoryPath(bili),
    });
    expect(categoryNavigationIntent(null, null, null)).toEqual({ kind: "replace", path: "/" });
  });

  test("recognises only our own history marker", () => {
    expect(isCategoryPushEntry(CATEGORY_PUSH_STATE)).toBe(true);
    expect(isCategoryPushEntry({ rliveCategorySource: "sidebar" })).toBe(false);
    expect(isCategoryPushEntry({ rliveNavigationSource: "sidebar" })).toBe(false);
    expect(isCategoryPushEntry(null)).toBe(false);
    expect(isCategoryPushEntry("home-category")).toBe(false);
  });
});

describe("selection to backend category", () => {
  test("resolves a cached child with its real name and picture", () => {
    expect(
      resolveSelectedCategory(multiParent, { parentId: "2", categoryId: "101,2" }),
    ).toEqual(child("2", "101,2", "和平精英"));
  });

  test("synthesises the aggregate child for id 0", () => {
    expect(resolveSelectedCategory(multiParent, { parentId: "3", categoryId: "0" })).toEqual(
      allCategoryOf(multiParent[2]!),
    );
  });

  test("falls back to a usable category before the tree arrives", () => {
    expect(resolveSelectedCategory(undefined, { parentId: "7", categoryId: "101,2" })).toEqual({
      id: "101,2",
      name: "分区直播",
      parent_id: "7",
      pic: null,
    });

    expect(
      resolveSelectedCategory([], { parentId: "7", categoryId: "101,2" }, "和平精英"),
    ).toEqual({
      id: "101,2",
      name: "和平精英",
      parent_id: "7",
      pic: null,
    });
  });
});

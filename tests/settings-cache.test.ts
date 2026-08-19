import { describe, expect, test } from "bun:test";
import { settingsCategorySearchText } from "../src/features/settings/SettingsPage";
import { formatByteSize } from "../src/lib/utils";

describe("image cache settings", () => {
  test("formats byte sizes at unit boundaries", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(1)).toBe("1 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1024 ** 2)).toBe("1.0 MB");
    expect(formatByteSize(1024 ** 3)).toBe("1.0 GB");
  });

  test("makes the data category searchable by cache terms", () => {
    expect(settingsCategorySearchText.data).toContain("缓存");
    expect(settingsCategorySearchText.data).toContain("图片");
    expect(settingsCategorySearchText.data).toContain("清除");
  });
});

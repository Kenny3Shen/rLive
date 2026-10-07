import { describe, expect, test } from "bun:test";
import { normalizeHttpProxy } from "../src/features/settings/ProxySettingsFields";

describe("自定义代理输入", () => {
  test("省略协议时补全 HTTP，保留认证信息和 IPv6", () => {
    expect(normalizeHttpProxy(" 127.0.0.1:7890 ")).toEqual({
      value: "http://127.0.0.1:7890/",
      error: null,
    });
    expect(normalizeHttpProxy("https://user:password@[::1]:7890")).toEqual({
      value: "https://user:password@[::1]:7890/",
      error: null,
    });
  });

  test("空地址和不支持的协议不应隐式切换为关闭", () => {
    for (const input of [
      "",
      "  ",
      "socks5://127.0.0.1:1080",
      "file:///tmp/proxy",
      "http://",
      "http://127.0.0.1:99999",
    ]) {
      const result = normalizeHttpProxy(input);
      expect(result.value).toBeNull();
      expect(result.error).toBeTruthy();
    }
  });
});

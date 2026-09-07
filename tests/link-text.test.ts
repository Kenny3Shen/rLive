import { describe, expect, test } from "bun:test";
import { linkifySegments } from "../src/shared/components/LinkText";

function links(text: string): { link: string; href: string }[] {
  const result: { link: string; href: string }[] = [];
  for (const segment of linkifySegments(text)) {
    if (segment.kind === "link") result.push({ link: segment.link, href: segment.href });
  }
  return result;
}

describe("linkifySegments", () => {
  test("无链接时返回单段正文", () => {
    expect(linkifySegments("普通弹幕内容，没有链接")).toEqual([
      { kind: "text", text: "普通弹幕内容，没有链接" },
    ]);
    expect(linkifySegments("")).toEqual([{ kind: "text", text: "" }]);
  });

  test("完整协议链接原样保留 href", () => {
    expect(links("详情见 https://example.com/a?b=1")).toEqual([
      { link: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
    ]);
    expect(links("http://insecure.example.com/")).toEqual([
      { link: "http://insecure.example.com/", href: "http://insecure.example.com/" },
    ]);
  });

  test("中文无空格也能截断链接", () => {
    expect(links("看https://b23.tv/xx就对了")).toEqual([
      { link: "https://b23.tv/xx", href: "https://b23.tv/xx" },
    ]);
  });

  test("裸域名带路径时补 https 前缀", () => {
    expect(links("求个三连 b23.tv/BV1xx411c7mD")).toEqual([
      { link: "b23.tv/BV1xx411c7mD", href: "https://b23.tv/BV1xx411c7mD" },
    ]);
    expect(links("主页 space.bilibili.com/12345")).toEqual([
      { link: "space.bilibili.com/12345", href: "https://space.bilibili.com/12345" },
    ]);
    expect(links("去 www.example.com/path 看")).toEqual([
      { link: "www.example.com/path", href: "https://www.example.com/path" },
    ]);
  });

  test("裸域名无路径与纯编号不误判", () => {
    expect(links("文件叫 img.png")).toEqual([]);
    expect(links("av170001 bv1xx411c7mD")).toEqual([]);
    expect(links("第1.5/3集")).toEqual([]);
  });

  test("句尾断句标点归还正文", () => {
    expect(linkifySegments("看b23.tv/xx。")).toEqual([
      { kind: "text", text: "看" },
      { kind: "link", link: "b23.tv/xx", href: "https://b23.tv/xx" },
      { kind: "text", text: "。" },
    ]);
    expect(linkifySegments("(https://example.com/a)")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", link: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: ")" },
    ]);
  });

  test("一条消息里的多个链接都被切出", () => {
    expect(links("https://a.com/1 和 b23.tv/yy 两个链接")).toEqual([
      { link: "https://a.com/1", href: "https://a.com/1" },
      { link: "b23.tv/yy", href: "https://b23.tv/yy" },
    ]);
  });

  test("大写域名与单字符路径段", () => {
    expect(links("去WWW.Example.COM/x")).toEqual([
      { link: "WWW.Example.COM/x", href: "https://WWW.Example.COM/x" },
    ]);
  });
});

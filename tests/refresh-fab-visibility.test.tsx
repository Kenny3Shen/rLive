import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { RefreshFab, RefreshFabVisibilityProvider } from "../src/shared/components/RefreshFab";

describe("refresh fab visibility", () => {
  test("keeps a hidden transition layer hidden through nested visible providers", () => {
    let refreshed = false;
    const html = renderToStaticMarkup(
      <RefreshFabVisibilityProvider visible={false}>
        <RefreshFabVisibilityProvider visible={true}>
          <RefreshFab onRefresh={() => (refreshed = true)} />
        </RefreshFabVisibilityProvider>
      </RefreshFabVisibilityProvider>,
    );

    expect(html).toBe("");
    expect(refreshed).toBe(false);
  });

  test("keeps incoming and outgoing transition layers structurally aligned", () => {
    for (const file of ["PagePan.tsx", "PageZoom.tsx"]) {
      const source = readFileSync(new URL(`../src/shared/motion/${file}`, import.meta.url), "utf8");
      const outgoing = source.indexOf("<RefreshFabVisibilityProvider visible={false}>");
      const incoming = source.indexOf("<RefreshFabVisibilityProvider visible={true}>");

      expect(outgoing).toBeGreaterThan(-1);
      expect(incoming).toBeGreaterThan(-1);
      expect(
        source.slice(outgoing, source.indexOf("</RefreshFabVisibilityProvider>", outgoing)),
      ).toContain("<RouterScope value={outgoing.router}>");
      expect(
        source.slice(incoming, source.indexOf("</RefreshFabVisibilityProvider>", incoming)),
      ).toContain("<RouterScope value={router}>{children}</RouterScope>");
    }
  });
});

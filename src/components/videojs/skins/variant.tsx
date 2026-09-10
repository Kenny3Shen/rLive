import { createContext, useContext, type ReactNode } from "react";

export type SkinVariant = "live" | "vod";

const SkinVariantContext = createContext<SkinVariant>("live");

/**
 * 皮肤把自己的形态告诉控制层：业务控件由调用方创建、由皮肤渲染，
 * 直播与点播的原生控件组合不同，只能从皮肤这一侧下发。
 */
export function SkinVariantProvider({
  value,
  children,
}: {
  value: SkinVariant;
  children: ReactNode;
}) {
  return <SkinVariantContext value={value}>{children}</SkinVariantContext>;
}

export function useSkinVariant(): SkinVariant {
  return useContext(SkinVariantContext);
}

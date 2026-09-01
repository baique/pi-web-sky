import { createContext, useContext } from "react";

/**
 * 玻璃作用域：区分「聊天页」与「看板画布」。
 * - default：气泡/浮层可用全局模糊壁纸图（background-attachment: fixed 在普通视口生效）。
 * - board：tldraw 容器内 fixed 失效（transform 容器），气泡自铺壁纸会变成「每气泡独立壁纸」；
 *   此处统一禁用全局壁纸图，气泡只保留半透明色层，透出卡片自身的局部模糊壁纸层。
 */
const GlassScopeContext = createContext<"default" | "board">("default");

export const GlassScopeProvider = GlassScopeContext.Provider;

export function useGlassScope(): "default" | "board" {
  return useContext(GlassScopeContext);
}

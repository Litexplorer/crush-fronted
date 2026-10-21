/**
 * themes.ts
 * 核心流程：主题注册表 ——
 *           内置 4 套（保证 Web 端始终有明暗选择）+ 由 Crush TUI 主题生成的 40 套；
 *           具体配色在 index.css / themes.generated.css 里按 html[data-theme="<id>"] 定义
 */
import { GENERATED_THEMES } from "./theme-palettes.generated"

export type ThemeMode = "dark" | "light"

export interface ThemeDef {
  id: string
  label: string
  mode: ThemeMode
  /** 下拉预览用：面板底色与强调色 */
  preview: { bg: string; accent: string }
}

/** 内置主题：不依赖 TUI 主题目录，保证任何时候都有深浅两种选择 */
export const BUILTIN_THEMES: ThemeDef[] = [
  { id: "dark", label: "Dark", mode: "dark", preview: { bg: "#161616", accent: "#3b82f6" } },
  { id: "light", label: "Light", mode: "light", preview: { bg: "#ffffff", accent: "#2c47c8" } },
  { id: "midnight", label: "Midnight", mode: "dark", preview: { bg: "#111a30", accent: "#4fe3c1" } },
  { id: "daybreak", label: "Daybreak", mode: "light", preview: { bg: "#ffffff", accent: "#0b7f6b" } },
]

/** 全部主题：内置在前，随后是按文件名排序的 TUI 主题 */
export const THEMES: ThemeDef[] = [
  ...BUILTIN_THEMES,
  ...GENERATED_THEMES.map(({ id, label, mode, bgBase, accent }) => ({
    id,
    label,
    mode,
    preview: { bg: bgBase, accent },
  })),
]

const THEME_INDEX = new Map(THEMES.map((theme) => [theme.id, theme]))

export type Theme = string

export const DEFAULT_THEME: Theme = "dark"

/**
 * isTheme
 * 参数：value localStorage 等外部来源的任意值
 * 核心流程：命中注册表才返回 true，脏数据一律回落默认主题
 */
export function isTheme(value: unknown): boolean {
  return typeof value === "string" && THEME_INDEX.has(value)
}

/**
 * themeMode
 * 参数：theme 主题 id
 * 核心流程：取该主题的明暗归类，供 mermaid / markmap 等非 CSS 消费者使用
 */
export function themeMode(theme: Theme): ThemeMode {
  return THEME_INDEX.get(theme)?.mode ?? "dark"
}

/**
 * themeLabel
 * 参数：theme 主题 id
 * 核心流程：取展示名，未注册时回落 id 本身
 */
export function themeLabel(theme: Theme): string {
  return THEME_INDEX.get(theme)?.label ?? theme
}

/**
 * themePreview
 * 参数：theme 主题 id
 * 核心流程：取下拉用的底色与强调色，未注册时给一套中性灰避免空白
 */
export function themePreview(theme: Theme): { bg: string; accent: string } {
  return THEME_INDEX.get(theme)?.preview ?? { bg: "#161616", accent: "#3b82f6" }
}

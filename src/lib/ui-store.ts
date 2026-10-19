/**
 * ui-store.ts
 * 参数：无
 * 核心流程：全局 UI 状态 ——
 *           主题（dark/light，localStorage 持久化，写入 html[data-theme]）
 *           当前打开的会话（标题栏标签页展示用）
 */
import { createSignal } from "solid-js"

export type Theme = "dark" | "light"

const THEME_KEY = "crush.theme"

/**
 * readTheme
 * 参数：无
 * 核心流程：从 localStorage 读取主题，非 light 一律回落 dark
 */
function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

/**
 * applyTheme
 * 参数：theme 目标主题
 * 核心流程：写入 html[data-theme]，驱动 index.css 里的 CSS 变量切换
 */
function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  document.documentElement.dataset.theme = theme
}

const [theme, setThemeSignal] = createSignal<Theme>(readTheme())
applyTheme(theme())

/**
 * setTheme
 * 参数：next 目标主题
 * 核心流程：更新 signal + 立即应用 + 持久化；存储失败不影响当前会话
 */
export function setTheme(next: Theme) {
  setThemeSignal(next)
  applyTheme(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    // localStorage 不可用：仅当前会话内生效
  }
}

export { theme }

export interface ActiveSession {
  id: string
  title: string
  workspaceId: string
}

/** 已打开的会话标签：按打开顺序保存，同一 session 不重复 */
const [openSessions, setOpenSessions] = createSignal<ActiveSession[]>([])
const [activeSession, setActiveSession] = createSignal<ActiveSession>()

export { activeSession, openSessions, setActiveSession }

/**
 * ensureSessionTab
 * 参数：tab 会话标签
 * 核心流程：不存在则追加，已存在则保留原标题并更新 workspaceId；
 *           同时把该标签设为当前会话（用于路由进入新会话）
 */
export function ensureSessionTab(tab: ActiveSession) {
  const existing = openSessions().find((item) => item.id === tab.id)
  setOpenSessions((prev) => {
    if (existing && existing.workspaceId === tab.workspaceId) return prev
    if (!existing) return [...prev, tab]
    return prev.map((item) => (item.id === tab.id ? { ...item, workspaceId: tab.workspaceId } : item))
  })
  setActiveSession((prev) => {
    const base = prev?.id === tab.id ? prev : existing
    return base ? { ...base, workspaceId: tab.workspaceId } : tab
  })
}

/**
 * updateSessionTab
 * 参数：tab 会话标签（标题/工作区可更新）
 * 核心流程：按 id 原地合并字段；若该会话是当前会话，同步更新 activeSession
 */
export function updateSessionTab(tab: ActiveSession) {
  setOpenSessions((prev) => {
    const index = prev.findIndex((item) => item.id === tab.id)
    if (index === -1) return [...prev, tab]
    const next = [...prev]
    next[index] = { ...next[index], ...tab }
    return next
  })
  setActiveSession((prev) => (prev?.id === tab.id ? { ...prev, ...tab } : prev))
}

/**
 * closeSessionTab
 * 参数：id 要关闭的会话 id
 * 核心流程：移除标签；若关闭的是当前会话，则优先选中右侧相邻标签，否则左侧；
 *           返回新的当前标签（没有则 undefined）供调用方决定是否跳转
 */
export function closeSessionTab(id: string): ActiveSession | undefined {
  let nextActive: ActiveSession | undefined
  setOpenSessions((prev) => {
    const index = prev.findIndex((item) => item.id === id)
    if (index === -1) return prev
    nextActive = prev[index + 1] ?? prev[index - 1]
    return prev.filter((item) => item.id !== id)
  })
  setActiveSession((prev) => (prev?.id === id ? nextActive : prev))
  return nextActive
}

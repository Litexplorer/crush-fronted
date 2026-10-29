/**
 * ui-store.ts
 * 参数：无
 * 核心流程：全局 UI 状态 ——
 *           主题（注册表见 lib/themes.ts，localStorage 持久化，写入 html[data-theme]）
 *           当前打开的会话（标题栏标签页展示用）
 */
import { createSignal } from "solid-js"
import { cancelPrefix } from "./key-prefix"
import { DEFAULT_THEME, isTheme, type Theme } from "./themes"

export type { Theme } from "./themes"

const THEME_KEY = "crush.theme"

/**
 * readTheme
 * 参数：无
 * 核心流程：从 localStorage 读取主题，命中注册表才采信，否则回落默认主题
 */
function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (typeof stored === "string" && isTheme(stored)) return stored
    // 主题被删除或手写错误时把脏值纠正回默认，避免 localStorage 长期残留无效 id
    if (stored !== null) localStorage.setItem(THEME_KEY, DEFAULT_THEME)
    return DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * syncThemeColor
 * 参数：无
 * 核心流程：把地址栏 theme-color 同步为当前 --bg-deep；样式尚未注入时读到空值，
 *           交给调用方下一帧重试，避免把地址栏留成默认深色
 */
function syncThemeColor() {
  const bgDeep = getComputedStyle(document.documentElement).getPropertyValue("--bg-deep").trim()
  const meta = document.querySelector('meta[name="theme-color"]')
  if (bgDeep && meta) meta.setAttribute("content", bgDeep)
}

/**
 * applyTheme
 * 参数：theme 目标主题
 * 核心流程：写入 html[data-theme] 驱动 index.css 变量切换 → 同步 theme-color；
 *           首帧样式可能还没生效，下一帧再同步一次兜底
 */
function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  document.documentElement.dataset.theme = theme
  syncThemeColor()
  requestAnimationFrame(syncThemeColor)
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
  /** 项目路径：workspace id 是服务端内存态，重启后按路径重新解析 */
  projectPath?: string
}

const TABS_KEY = "crush.tabs"
const MAX_TABS = 20

/**
 * readSessionTabs
 * 参数：无
 * 核心流程：从 localStorage 恢复标签；丢弃缺少 id 的脏数据，限制数量避免无限增长
 */
function readSessionTabs(): ActiveSession[] {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((tab) => typeof tab.id === "string" && tab.id !== "")
      .slice(0, MAX_TABS)
      .map((tab) => ({
        id: tab.id as string,
        title: typeof tab.title === "string" && tab.title ? tab.title : "Untitled",
        workspaceId: typeof tab.workspaceId === "string" ? tab.workspaceId : "",
        projectPath: typeof tab.projectPath === "string" && tab.projectPath ? tab.projectPath : undefined,
      }))
  } catch {
    return []
  }
}

/**
 * persistSessionTabs
 * 参数：tabs 当前标签列表
 * 核心流程：写入 localStorage；存储失败时仅本次页面生效
 */
function persistSessionTabs(tabs: ActiveSession[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
  } catch {
    // localStorage 不可用：跳过持久化
  }
}

/** 已打开的会话标签：初始化时从 localStorage 恢复，同一 session 不重复 */
const [openSessions, setOpenSessions] = createSignal<ActiveSession[]>(readSessionTabs())
const [activeSession, setActiveSession] = createSignal<ActiveSession>()

export { activeSession, openSessions, setActiveSession }

/**
 * ensureSessionTab
 * 参数：tab 会话标签
 * 核心流程：不存在则追加，已存在则保留原标题并更新 workspaceId；
 *           同时把该标签设为当前会话（用于路由进入新会话）
 */
export function ensureSessionTab(tab: ActiveSession) {
  let next = openSessions()
  setOpenSessions((prev) => {
    const existing = prev.find((item) => item.id === tab.id)
    if (!existing) {
      next = [...prev, tab].slice(0, MAX_TABS)
    } else {
      // 已有标签保留真实标题，只同步工作区与项目路径
      const merged: ActiveSession = {
        ...existing,
        ...tab,
        title: tab.title && tab.title !== "Untitled" ? tab.title : existing.title,
        projectPath: tab.projectPath ?? existing.projectPath,
      }
      const changed =
        merged.title !== existing.title ||
        merged.workspaceId !== existing.workspaceId ||
        merged.projectPath !== existing.projectPath
      next = changed ? prev.map((item) => (item.id === tab.id ? merged : item)) : prev
    }
    persistSessionTabs(next)
    return next
  })
  setActiveSession((prev) => {
    const base = prev?.id === tab.id ? prev : next.find((item) => item.id === tab.id)
    if (!base) return tab
    return {
      ...base,
      workspaceId: tab.workspaceId || base.workspaceId,
      projectPath: tab.projectPath ?? base.projectPath,
      title: tab.title && tab.title !== "Untitled" ? tab.title : base.title,
    }
  })
}

/**
 * replaceSessionTab
 * 参数：oldId 被顶替的会话标签 id；tab 新会话标签
 * 核心流程：同索引替换并持久化 → 设新标签为当前会话；
 *           旧标签已不存在（被关闭等）时退化为追加，保证新会话一定在标签栏出现
 */
export function replaceSessionTab(oldId: string, tab: ActiveSession) {
  let replaced = false
  setOpenSessions((prev) => {
    const index = prev.findIndex((item) => item.id === oldId)
    if (index === -1) return prev
    replaced = true
    const next = [...prev]
    next[index] = tab
    persistSessionTabs(next)
    return next
  })
  if (!replaced) {
    ensureSessionTab(tab)
    return
  }
  setActiveSession(tab)
}

/**
 * updateSessionTab
 * 参数：tab 会话标签（标题/工作区可更新）
 * 核心流程：按 id 原地合并字段；若该会话是当前会话，同步更新 activeSession
 */
export function updateSessionTab(tab: ActiveSession) {
  setOpenSessions((prev) => {
    const index = prev.findIndex((item) => item.id === tab.id)
    let next: ActiveSession[]
    if (index === -1) {
      next = [...prev, tab].slice(0, MAX_TABS)
    } else {
      next = [...prev]
      next[index] = { ...next[index], ...tab, projectPath: tab.projectPath ?? next[index].projectPath }
    }
    persistSessionTabs(next)
    return next
  })
  setActiveSession((prev) =>
    prev?.id === tab.id ? { ...prev, ...tab, projectPath: tab.projectPath ?? prev.projectPath } : prev,
  )
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
    const next = prev.filter((item) => item.id !== id)
    persistSessionTabs(next)
    return next
  })
  setActiveSession((prev) => (prev?.id === id ? nextActive : prev))
  return nextActive
}

/**
 * reorderSessionTabs
 * 参数：sourceId 被拖拽标签；targetId 落点标签；after 是否插到落点右侧
 * 核心流程：移除源标签 → 按 id 重新定位落点 → 插入并持久化；
 *           顺序未变化时直接返回，避免无意义写入
 */
export function reorderSessionTabs(sourceId: string, targetId: string, after: boolean) {
  setOpenSessions((prev) => {
    const from = prev.findIndex((item) => item.id === sourceId)
    if (from === -1 || !prev.some((item) => item.id === targetId) || sourceId === targetId) return prev
    const next = [...prev]
    const [moved] = next.splice(from, 1)
    // 源标签移除后落点下标可能左移，按 id 重新定位
    const at = next.findIndex((item) => item.id === targetId) + (after ? 1 : 0)
    next.splice(at, 0, moved)
    if (next.every((item, index) => item.id === prev[index].id)) return prev
    persistSessionTabs(next)
    return next
  })
}

/**
 * retargetSessionTabs
 * 参数：projectPath 项目路径；workspaceId 当前有效的 workspace id
 * 核心流程：服务端重启后 workspace id 全部失效，按路径把同项目的标签批量指向新 id，
 *           避免每个标签各自重建
 */
export function retargetSessionTabs(projectPath: string, workspaceId: string) {
  if (!projectPath || !workspaceId) return
  setOpenSessions((prev) => {
    if (!prev.some((item) => item.projectPath === projectPath && item.workspaceId !== workspaceId)) return prev
    const next = prev.map((item) => (item.projectPath === projectPath ? { ...item, workspaceId } : item))
    persistSessionTabs(next)
    return next
  })
  setActiveSession((prev) => (prev && prev.projectPath === projectPath ? { ...prev, workspaceId } : prev))
}

/** 标签栏布局：横向（顶栏）或纵向（左侧栏） */
export type TabsOrientation = "horizontal" | "vertical"

const TABS_ORIENTATION_KEY = "crush.tabsOrientation"

/**
 * readTabsOrientation
 * 参数：无
 * 核心流程：从 localStorage 读取布局偏好，只认 "vertical"，其余一律回落横向；
 *           存储不可用时同样回落，避免首屏渲染报错
 */
function readTabsOrientation(): TabsOrientation {
  try {
    return localStorage.getItem(TABS_ORIENTATION_KEY) === "vertical" ? "vertical" : "horizontal"
  } catch {
    return "horizontal"
  }
}

const [tabsOrientation, setTabsOrientationSignal] = createSignal<TabsOrientation>(readTabsOrientation())

export { tabsOrientation }

/**
 * setTabsOrientation
 * 参数：next 目标布局
 * 核心流程：更新 signal 驱动布局重排 → 写入 localStorage；存储失败仅本次页面生效
 */
export function setTabsOrientation(next: TabsOrientation) {
  setTabsOrientationSignal(next)
  try {
    localStorage.setItem(TABS_ORIENTATION_KEY, next)
  } catch {
    // localStorage 不可用：仅当前会话内生效
  }
}

/**
 * toggleTabsOrientation
 * 参数：无
 * 核心流程：在横向/纵向之间切换，供标题栏按钮调用
 */
export function toggleTabsOrientation() {
  setTabsOrientation(tabsOrientation() === "vertical" ? "horizontal" : "vertical")
}

/** 命令面板开关：App 负责渲染，标签栏据此让出方向键与 Ctrl+K */
const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false)

export { commandPaletteOpen }

/**
 * toggleCommandPalette
 * 参数：无
 * 核心流程：Ctrl+K 开关面板；打开时取消前缀待命，避免残留的方向键状态
 */
export function toggleCommandPalette() {
  setCommandPaletteOpen((open) => {
    if (!open) cancelPrefix()
    return !open
  })
}

/**
 * closeCommandPalette
 * 参数：无
 * 核心流程：面板内执行动作或按 Esc 后关闭
 */
export function closeCommandPalette() {
  setCommandPaletteOpen(false)
}

/** 标签列表浮层（前缀 + G）：按项目分组展示已打开的标签 */
const [tabSwitcherOpen, setTabSwitcherOpen] = createSignal(false)
/** 快捷键说明浮层（前缀 + ?） */
const [shortcutHelpOpen, setShortcutHelpOpen] = createSignal(false)
/** 历史会话浮层（命令面板入口）：独立窗口，不占命令面板的列表 */
const [historyDialogOpen, setHistoryDialogOpen] = createSignal(false)
/** 本会话问题浮层（前缀 + Q）：读会话页发布的问句索引 */
const [questionDialogOpen, setQuestionDialogOpen] = createSignal(false)
/** 模型列表浮层（前缀 + M）：列出当前工作区的全部模型并切换 */
const [modelDialogOpen, setModelDialogOpen] = createSignal(false)

export { historyDialogOpen, modelDialogOpen, questionDialogOpen, shortcutHelpOpen, tabSwitcherOpen }

/**
 * openTabSwitcher / closeTabSwitcher
 * 参数：无
 * 核心流程：前缀 + G 打开列表；打开时取消前缀待命，关闭由 Esc、选中或点遮罩触发
 */
export function openTabSwitcher() {
  cancelPrefix()
  setTabSwitcherOpen(true)
}

export function closeTabSwitcher() {
  setTabSwitcherOpen(false)
}

/**
 * openShortcutHelp / closeShortcutHelp
 * 参数：无
 * 核心流程：前缀 + ? 打开快捷键说明；同样取消前缀待命
 */
export function openShortcutHelp() {
  cancelPrefix()
  setShortcutHelpOpen(true)
}

export function closeShortcutHelp() {
  setShortcutHelpOpen(false)
}

/**
 * openHistoryDialog / closeHistoryDialog
 * 参数：无
 * 核心流程：从命令面板打开「历史会话」独立浮层；打开时取消前缀待命
 */
export function openHistoryDialog() {
  cancelPrefix()
  setHistoryDialogOpen(true)
}

export function closeHistoryDialog() {
  setHistoryDialogOpen(false)
}

/**
 * openQuestionDialog / closeQuestionDialog
 * 参数：无
 * 核心流程：前缀 + Q 打开「本会话问题」浮层；打开时取消前缀待命
 */
export function openQuestionDialog() {
  cancelPrefix()
  setQuestionDialogOpen(true)
}

export function closeQuestionDialog() {
  setQuestionDialogOpen(false)
}

/**
 * openModelDialog / closeModelDialog
 * 参数：无
 * 核心流程：前缀 + M 打开模型列表浮层；打开时取消前缀待命，关闭由 Esc、选中或点遮罩触发
 */
export function openModelDialog() {
  cancelPrefix()
  setModelDialogOpen(true)
}

export function closeModelDialog() {
  setModelDialogOpen(false)
}

/**
 * 会话压缩请求（前缀 + U / 命令面板）：自增计数，由会话页监听后执行，
 * 因为 compact 依赖会话页内部的 agent 状态与消息列表，无法在全局直接调用
 */
const [compactRequest, setCompactRequest] = createSignal(0)

export { compactRequest }

/**
 * requestCompact
 * 参数：无
 * 核心流程：自增请求计数通知会话页执行压缩；先取消前缀待命，避免残留状态
 */
export function requestCompact() {
  cancelPrefix()
  setCompactRequest((prev) => prev + 1)
}

/**
 * runtimeOverlayOpen
 * 参数：无
 * 核心流程：判断是否有挡在页面上的全局浮层（命令面板 / 标签列表 / 快捷键说明 / 历史会话 / 模型列表）——
 *           这些浮层自己用方向键与字母键，标签栏快捷键必须让位
 */
export function runtimeOverlayOpen(): boolean {
  return (
    commandPaletteOpen() ||
    tabSwitcherOpen() ||
    shortcutHelpOpen() ||
    historyDialogOpen() ||
    questionDialogOpen() ||
    modelDialogOpen()
  )
}

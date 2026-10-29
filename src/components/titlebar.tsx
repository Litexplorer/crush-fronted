/**
 * titlebar.tsx
 * 参数：无
 * 核心流程：36px 顶栏（复刻 opencode 版式）——
 *           左侧：主页按钮 + 当前会话标签页（可关闭）+ 新建会话按钮
 *           右侧：主题切换按钮 + 后端连接状态圆点（GET /v1/health 轮询）
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { listSessions, renameSession, type Session } from "../lib/sessions"
import { selectedWorkspace } from "../lib/workspace-store"
import {
  activeSession,
  closeSessionTab,
  ensureSessionTab,
  openModelDialog,
  openQuestionDialog,
  openSessions,
  openShortcutHelp,
  openTabSwitcher,
  reorderSessionTabs,
  requestCompact,
  runtimeOverlayOpen,
  setActiveSession,
  tabsOrientation,
  toggleTabsOrientation,
  updateSessionTab,
  type ActiveSession,
} from "../lib/ui-store"
import { workspaceColor } from "../lib/workspace-color"
import { groupSessionTabs, type SessionTabGroup } from "../lib/session-groups"
import { isSessionRunning } from "../lib/run-status"
import { dismissNotification, isSessionUnread } from "../lib/notifications"
import { armPrefix, cancelPrefix, consumePrefix, prefixActive } from "../lib/key-prefix"
import { ensureLiveWorkspace, newSession, sessionUrl } from "../lib/session-actions"
import ThemeSelect from "./theme-select"
import StatusPopover from "./status-popover"
import { InlineTitle } from "./inline-title"
import NewSessionDialog from "./new-session-dialog"

type ConnectionState = "connected" | "disconnected"

/** 标签分组：同一项目（projectPath）下的会话标签归为一组，分组逻辑见 lib/session-groups */
type TabGroup = SessionTabGroup


/**
 * routeSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：提取 /session/:id 的最后一段并解码；非会话路由返回空串
 */
function routeSessionId(pathname: string): string {
  const match = /\/session\/([^/]+)\/?$/.exec(pathname)
  if (!match) return ""
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * checkHealth
 * 参数：无
 * 核心流程：请求 /v1/health，2xx 视为已连接；任何错误静默返回未连接
 */
async function checkHealth(): Promise<ConnectionState> {
  try {
    const res = await fetch("/v1/health", { method: "GET" })
    return res.ok ? "connected" : "disconnected"
  } catch {
    return "disconnected"
  }
}

export default function Titlebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const [state, setState] = createSignal<ConnectionState>("disconnected")
  const [creating, setCreating] = createSignal(false)
  // 新建失败的提示文案：不阻断当前会话，4s 后自动消失
  const [createError, setCreateError] = createSignal("")
  // 新建询问弹窗：选择「新 tab」或「覆盖当前 tab」
  const [newDialogOpen, setNewDialogOpen] = createSignal(false)
  let createErrorTimer: ReturnType<typeof setTimeout> | undefined
  // 快捷键切换中：解析 workspace 期间忽略连按，避免并发重建工作区
  const [switching, setSwitching] = createSignal(false)
  const [statusOpen, setStatusOpen] = createSignal(false)
  // 当前路由对应的会话标签：用于高亮与工作区回退
  const currentSessionId = () => routeSessionId(location.pathname)
  // 标签栏布局：纵向时标签移到左侧栏，顶栏只保留操作按钮
  const vertical = () => tabsOrientation() === "vertical"
  const currentTab = () => openSessions().find((tab) => tab.id === currentSessionId())
  // 工作区配色键：项目路径优先，旧标签缺失路径时退化为 workspace id
  const tabColor = (tab: ActiveSession) => workspaceColor(tab.projectPath ?? tab.workspaceId)
  /**
   * tabGroups
   * 参数：无
   * 核心流程：按项目把标签分组（按首次出现顺序），组键用 projectPath ——
   *           workspace id 是服务端内存态，重启后会变
   */
  const tabGroups = createMemo<TabGroup[]>(() => groupSessionTabs(openSessions()))

  /**
   * visibleTabs
   * 参数：无
   * 核心流程：把分组展平成语义上的可见顺序（组顺序 + 组内顺序）——
   *           切换/键盘导航/关闭邻居全部以它为准，保证与标题栏渲染一致
   */
  const visibleTabs = createMemo<ActiveSession[]>(() => tabGroups().flatMap((group) => group.tabs))

  // 状态浮层数据源：当前会话所属工作区，回退到首页选中项
  const statusWsId = () => currentTab()?.workspaceId ?? selectedWorkspace()?.id ?? activeSession()?.workspaceId

  // 标签溢出与「已存在会话」选择器
  let stripRef: HTMLDivElement | undefined
  let stripObserver: ResizeObserver | undefined
  let searchRef: HTMLInputElement | undefined
  const [canLeft, setCanLeft] = createSignal(false)
  const [canRight, setCanRight] = createSignal(false)
  const [tabsMenu, setTabsMenu] = createSignal(false)
  // 标签拖拽排序：draggingTabId 拖拽源，dropTarget 落点（after 表示插到目标右侧）
  const [draggingTabId, setDraggingTabId] = createSignal("")
  const [dropTarget, setDropTarget] = createSignal<{ id: string; after: boolean }>()
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [pickerLoading, setPickerLoading] = createSignal(false)
  const [pickerError, setPickerError] = createSignal("")
  const [pickerSessions, setPickerSessions] = createSignal<Session[]>([])
  const [pickerQuery, setPickerQuery] = createSignal("")
  const [pickerWsId, setPickerWsId] = createSignal("")

  /** 选择器里的「已打开标签」：按项目分组，按查询过滤后丢弃空组 */
  const filteredTabGroups = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase()
    return tabGroups()
      .map((group) => ({
        ...group,
        tabs: query
          ? group.tabs.filter((tab) => (tab.title || "Untitled").toLowerCase().includes(query))
          : group.tabs,
      }))
      .filter((group) => group.tabs.length > 0)
  })

  const filteredSessions = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase()
    if (!query) return pickerSessions()
    return pickerSessions().filter((session) => (session.title || "Untitled").toLowerCase().includes(query))
  })

  /**
   * updateScrollState
   * 参数：无
   * 核心流程：根据标签条滚动位置计算左右是否还有被裁掉的标签，
   *           驱动左右滚动按钮的显隐
   */
  function updateScrollState() {
    const el = stripRef
    if (!el) return
    setCanLeft(el.scrollLeft > 2)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }

  /**
   * scrollTabs
   * 参数：delta 滚动增量（负左正右）
   * 核心流程：平滑横向滚动标签条
   */
  function scrollTabs(delta: number) {
    stripRef?.scrollBy({ left: delta, behavior: "smooth" })
  }

  /**
   * attachStrip
   * 参数：el 横向标签条元素
   * 核心流程：切换布局会重建标签条，用回调 ref 重新挂 ResizeObserver，
   *           替代只在挂载时绑定一次的写法
   */
  function attachStrip(el: HTMLDivElement) {
    stripRef = el
    stripObserver?.disconnect()
    stripObserver = new ResizeObserver(updateScrollState)
    stripObserver.observe(el)
    updateScrollState()
  }

  // 标签增删、布局切换后重新计算溢出状态（DOM 更新后测量）
  createEffect(() => {
    openSessions()
    vertical()
    queueMicrotask(updateScrollState)
  })

  /**
   * togglePicker
   * 参数：无
   * 核心流程：打开「选择已有会话」浮层 → 解析当前工作区 → 拉取会话列表并按更新时间倒序
   */
  async function togglePicker() {
    if (pickerOpen()) {
      setPickerOpen(false)
      return
    }
    const fallback = currentTab()?.workspaceId ?? selectedWorkspace()?.id ?? activeSession()?.workspaceId
    const path = selectedWorkspace()?.path ?? currentTab()?.projectPath
    if (!fallback && !path) {
      navigate("/")
      return
    }
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerError("")
    setPickerQuery("")
    setPickerSessions([])
    try {
      const wsId = await ensureLiveWorkspace(path, fallback)
      if (!wsId) throw new Error("Workspace unavailable")
      setPickerWsId(wsId)
      const list = await listSessions(wsId)
      setPickerSessions([...list].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)))
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : "Failed to load sessions")
    }
    setPickerLoading(false)
    queueMicrotask(() => searchRef?.focus())
  }

  /**
   * openExisting
   * 参数：session 从选择器里挑中的会话
   * 核心流程：登记标签（保留项目路径）→ 关闭浮层 → 跳转会话页
   */
  function openExisting(session: Session) {
    const wsId = pickerWsId()
    if (!wsId) return
    const path = selectedWorkspace()?.path ?? currentTab()?.projectPath
    const tab: ActiveSession = {
      id: session.id,
      title: session.title || "Untitled",
      workspaceId: wsId,
      projectPath: path,
    }
    ensureSessionTab(tab)
    setPickerOpen(false)
    navigate(sessionUrl(tab))
  }

  onMount(() => onCleanup(() => stripObserver?.disconnect()))

  onMount(() => {
    // 首次探测 + 每 5s 轮询，结果驱动状态圆点颜色
    let timer: ReturnType<typeof setInterval> | undefined

    const poll = () => {
      void checkHealth().then(setState)
    }

    poll()
    timer = setInterval(poll, 5000)

    onCleanup(() => clearInterval(timer))
  })

  onMount(() => {
    // 全局快捷键：Ctrl+B 当前缀，之后单独按 ←/→ 组内切换、Shift+←/→ 按项目跳组（挂在 document 上）
    document.addEventListener("keydown", handlePrefixShortcut)
    document.addEventListener("keydown", handleTabShortcut)
    onCleanup(() => {
      document.removeEventListener("keydown", handlePrefixShortcut)
      document.removeEventListener("keydown", handleTabShortcut)
    })
  })

  onMount(() => {
    /**
     * handleNewSessionShortcut
     * 参数：event 键盘事件
     * 核心流程：Ctrl/Cmd+Shift+N 新建会话并顶替当前标签位（替换模式走快捷键）
     */
    const handleNewSessionShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== "n") return
      event.preventDefault()
      void handleNewSession(true)
    }
    document.addEventListener("keydown", handleNewSessionShortcut)
    onCleanup(() => {
      document.removeEventListener("keydown", handleNewSessionShortcut)
      clearTimeout(createErrorTimer)
    })
  })

  /**
   * reportCreateError
   * 参数：message 新建失败原因
   * 核心流程：写入提示并在 4s 后清空，避免顶栏常驻错误文案
   */
  function reportCreateError(message: string) {
    setCreateError(message)
    clearTimeout(createErrorTimer)
    createErrorTimer = setTimeout(() => setCreateError(""), 4000)
  }

  /**
   * handleNewSession
   * 参数：replace 为 true 时新会话顶替当前标签位（不新增标签）
   * 核心流程：取当前标签的 workspace/项目路径 → newSession（复用已知 workspace id 直连，
   *           失败才按路径重建）→ 成功跳转新会话；失败保留当前会话与草稿，只提示错误
   */
  async function handleNewSession(replace: boolean) {
    setNewDialogOpen(false)
    const tab = currentTab()
    const fallback = tab?.workspaceId ?? selectedWorkspace()?.id ?? activeSession()?.workspaceId
    const path = selectedWorkspace()?.path ?? tab?.projectPath
    if (creating()) return
    if (!fallback && !path) {
      navigate("/")
      return
    }
    setCreating(true)
    setCreateError("")
    try {
      // 新建会话：已有 workspace id 直接复用，替换模式下顶替当前标签位
      const result = await newSession({
        workspaceId: fallback,
        projectPath: path,
        replaceSessionId: replace ? tab?.id : undefined,
      })
      if (!result.ok) {
        reportCreateError(result.error)
        return
      }
      navigate(sessionUrl(result.tab))
    } finally {
      setCreating(false)
    }
  }

  /**
   * openTab
   * 参数：tab 目标会话标签
   * 核心流程：先按项目路径解析当前有效 workspace（服务端重启后 id 会变）→
   *           设为当前会话并跳转到对应会话页
   */
  async function openTab(tab: ActiveSession) {
    const wsId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: wsId ?? tab.workspaceId }
    setActiveSession(target)
    navigate(sessionUrl(target))
  }

  /**
   * commitRename
   * 参数：tab 目标标签；next 新标题（InlineTitle 已 trim 且与旧值不同）
   * 核心流程：先按项目路径解析当前有效 workspace（服务端重启后 id 会变）→
   *           PUT 标题子资源 → 同步标签栏标题；失败保持原标题并打日志
   */
  async function commitRename(tab: ActiveSession, next: string) {
    const wsId = (await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)) ?? tab.workspaceId
    try {
      const saved = await renameSession(wsId, tab.id, next)
      updateSessionTab({ id: saved.id, title: saved.title || "Untitled", workspaceId: wsId })
    } catch (err) {
      console.warn(`[crush] rename session failed: ${(err as { message?: string })?.message ?? "unknown"}`)
    }
  }

  /**
   * switchTab
   * 参数：delta 方向（1 下一个 / -1 上一个）
   * 核心流程：按标签展示顺序取相邻标签（首尾循环）→ 复用 openTab 切换；
   *           不在会话页时从首/尾进入；解析 workspace 期间忽略连按
   */
  async function switchTab(delta: 1 | -1) {
    if (switching()) return
    // 取分组后的可见顺序：直接读 openSessions() 会跨项目乱跳
    const tabs = visibleTabs()
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.id === currentSessionId())
    const next = index === -1 ? (delta > 0 ? 0 : tabs.length - 1) : (index + delta + tabs.length) % tabs.length
    if (next === index) return
    setSwitching(true)
    try {
      await openTab(tabs[next])
    } finally {
      setSwitching(false)
    }
  }

  /**
   * tabArrowKeys
   * 参数：无
   * 核心流程：按标签栏方向给出「上一个 / 下一个」对应的方向键；
   *           横向用 ←/→，纵向用 ↑/↓，前缀处理与切换逻辑共用同一份轴定义
   */
  function tabArrowKeys(): [string, string] {
    return vertical() ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]
  }

  /**
   * handlePrefixShortcut
   * 参数：event 全局键盘事件
   * 核心流程：Ctrl/Cmd+B 进入「前缀待命」（输入框里同样生效，先 preventDefault 挡掉加粗等默认行为）；
   *           待命期间按 N 新建会话、G 打开标签列表、Q 看本会话提问、M 切模型、U 压缩会话、? 看快捷键、
   *           按本轴方向键切换标签，
   *           其余按键（含另一根轴的方向键）立即退出待命
   */
  function handlePrefixShortcut(event: KeyboardEvent) {
    if (event.isComposing) return
    // 浮层打开时不接管：它们自己处理按键（命令面板输入框、标签列表的上下选择）
    if (runtimeOverlayOpen()) {
      if (prefixActive()) cancelPrefix()
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault()
      armPrefix()
      return
    }
    if (!prefixActive()) return
    // 只按修饰键不算「别的键」：待命要留到方向键按下
    if (event.key === "Control" || event.key === "Shift" || event.key === "Alt" || event.key === "Meta") return
    // 前缀 + N：新建会话（追加标签，替换当前标签仍走 Ctrl+Shift+N）
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
      event.preventDefault()
      consumePrefix()
      void handleNewSession(false)
      return
    }
    // 前缀 + G：按项目分组列出已打开的标签，可搜索
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
      event.preventDefault()
      consumePrefix()
      openTabSwitcher()
      return
    }
    // 前缀 + Q：列出本会话的提问（可搜索，Enter 跳转）
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "q") {
      event.preventDefault()
      consumePrefix()
      openQuestionDialog()
      return
    }
    // 前缀 + M：列出当前工作区的全部模型并切换
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault()
      consumePrefix()
      openModelDialog()
      return
    }
    // 前缀 + U：压缩当前会话（交给会话页执行，这里只广播请求）
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      consumePrefix()
      requestCompact()
      return
    }
    // 前缀 + ?：快捷键说明（Shift+/ 与 ? 都接受）
    if (event.key === "?" || (event.shiftKey && event.key === "/")) {
      event.preventDefault()
      consumePrefix()
      openShortcutHelp()
      return
    }
    const [prevKey, nextKey] = tabArrowKeys()
    // 本轴方向键不再需要 Ctrl：直接交给 handleTabShortcut 消费
    if (event.key === prevKey || event.key === nextKey) return
    cancelPrefix()
  }

  /**
   * handleTabShortcut
   * 参数：event 全局键盘事件
   * 核心流程：先按 Ctrl+B 进入待命，随后单独按方向键即可组内切换标签、
   *           按 Shift+方向键按项目跳组；没有前缀一律不处理，方向键保持原生含义
   */
  function handleTabShortcut(event: KeyboardEvent) {
    if (event.isComposing) return
    if (event.altKey) return
    if (pickerOpen() || tabsMenu() || runtimeOverlayOpen()) return
    const [prevKey, nextKey] = tabArrowKeys()
    if (event.key !== prevKey && event.key !== nextKey) return
    // 必须以前缀（Ctrl+B）开头：否则会和编辑态的方向键抢
    if (!consumePrefix()) return
    event.preventDefault()
    const delta: 1 | -1 = event.key === nextKey ? 1 : -1
    // 带 Shift：按项目分组跳（相邻项目的第一个标签）；不带 Shift：组内线性切换
    if (event.shiftKey) {
      void switchGroup(delta)
      return
    }
    void switchTab(delta)
  }

  /**
   * closeTab
   * 参数：tab 要关闭的标签
   * 核心流程：从标签列表移除并丢弃它的完成通知（标签都没了，气泡与角标没意义）；
   *           若关闭的是当前路由会话，跳转到相邻标签，没有相邻标签则回工作区首页
   */
  function closeTab(tab: ActiveSession) {
    dismissNotification(tab.id)
    const closingActiveRoute = currentSessionId() === tab.id
    if (!closingActiveRoute) {
      closeSessionTab(tab.id)
      return
    }
    // 先按可见顺序选邻居：分组渲染后，数组里的相邻项未必是屏幕上的相邻项
    const order = visibleTabs()
    const index = order.findIndex((item) => item.id === tab.id)
    const neighbour = index === -1 ? undefined : (order[index + 1] ?? order[index - 1])
    closeSessionTab(tab.id)
    if (neighbour) navigate(sessionUrl(neighbour))
    else navigate(`/w/${encodeURIComponent(tab.workspaceId)}`)
  }

  /**
   * focusTabButton
   * 参数：id 标签对应的会话 ID
   * 核心流程：连续几帧把焦点交回该标签按钮 —— 切换会话会重排标签行，
   *           元素被重建后焦点会丢失，重复几帧保证最终落在按钮上
   */
  function focusTabButton(id: string) {
    const attempt = (left: number) => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLButtonElement>(
          `[data-session-tab="${CSS.escape(id)}"] [role="tab"]`,
        )
        if (el && document.activeElement !== el) el.focus()
        if (left > 0) attempt(left - 1)
      })
    }
    attempt(2)
  }

  /**
   * onTabKeyDown
   * 参数：event 键盘事件；index 标签在当前列表中的下标
   * 核心流程：←/→ 按展示顺序移动焦点并切换会话（首尾循环），Home/End 跳首尾，
   *           Delete 关闭当前标签并把焦点交给相邻标签
   */
  function onTabKeyDown(event: KeyboardEvent, tabId: string) {
    // 与渲染一致：在分组后的可见顺序上取相邻标签
    const tabs = visibleTabs()
    const index = tabs.findIndex((tab) => tab.id === tabId)
    const current = tabs[index]
    if (!current) return
    const go = (target: number) => {
      const next = tabs[target]
      if (!next || next.id === current.id) return
      event.preventDefault()
      // 等切换真正落地（含 workspace 解析）再交回焦点，否则标签行重建会吃掉焦点
      void openTab(next).then(() => focusTabButton(next.id))
    }
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        go((index - 1 + tabs.length) % tabs.length)
        return
      case "ArrowRight":
      case "ArrowDown":
        go((index + 1) % tabs.length)
        return
      case "Home":
        go(0)
        return
      case "End":
        go(tabs.length - 1)
        return
      case "Delete": {
        event.preventDefault()
        // 关闭后焦点顺着相邻标签走，避免键盘操作断档
        const neighbour = tabs[index + 1] ?? tabs[index - 1]
        closeTab(current)
        if (neighbour) focusTabButton(neighbour.id)
        return
      }
    }
  }

  /** 漫游 tabindex：每组只有一个标签进入 Tab 序列（优先当前会话所在标签） */
  const rovingTabId = () => {
    const list = visibleTabs()
    if (list.some((tab) => tab.id === currentSessionId())) return currentSessionId()
    return list[0]?.id ?? ""
  }

  /**
   * switchGroup
   * 参数：delta 方向（1 下一个项目 / -1 上一个项目，首尾循环）
   * 核心流程：按分组顺序取相邻项目 → 打开该组的第一个标签；
   *           只有一个项目时不做任何事
   */
  async function switchGroup(delta: 1 | -1) {
    const groups = tabGroups()
    if (groups.length < 2) return
    const currentKey = currentTab()?.projectPath || currentTab()?.workspaceId
    const index = groups.findIndex((group) => group.key === currentKey)
    const next = index === -1 ? 0 : (index + delta + groups.length) % groups.length
    const target = groups[next]?.tabs[0]
    if (!target || next === index) return
    await openTab(target)
  }

  /**
   * startTabDrag
   * 参数：event 拖拽事件；tab 被拖拽标签
   * 核心流程：记录拖拽源并写入 dataTransfer，供 drop 时跨元素取回
   */
  function startTabDrag(event: DragEvent, tab: ActiveSession) {
    setDraggingTabId(tab.id)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", tab.id)
    }
  }

  /**
   * overTab
   * 参数：event 拖拽事件；tab 当前悬停的标签
   * 核心流程：阻止默认行为以允许 drop，并按鼠标在目标左/右半区计算插入侧
   */
  function overTab(event: DragEvent, tab: ActiveSession) {
    const sourceId = draggingTabId()
    if (!sourceId || sourceId === tab.id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    // 纵向标签栏按上/下半区判断插入位，横向按左/右半区
    const after = vertical()
      ? event.clientY > rect.top + rect.height / 2
      : event.clientX > rect.left + rect.width / 2
    const current = dropTarget()
    if (!current || current.id !== tab.id || current.after !== after) setDropTarget({ id: tab.id, after })
  }

  /**
   * dropTab
   * 参数：event drop 事件；tab 落点标签
   * 核心流程：取拖拽源与落点侧 → 调用 store 重排并持久化 → 清空拖拽态
   */
  function dropTab(event: DragEvent, tab: ActiveSession) {
    event.preventDefault()
    const sourceId = event.dataTransfer?.getData("text/plain") || draggingTabId()
    const target = dropTarget()
    if (sourceId && sourceId !== tab.id) {
      reorderSessionTabs(sourceId, tab.id, target?.id === tab.id ? target.after : true)
    }
    setDraggingTabId("")
    setDropTarget(undefined)
  }

  /**
   * endTabDrag
   * 参数：无
   * 核心流程：拖拽结束（包括拖出标签条）时清空高亮与插入指示
   */
  function endTabDrag() {
    setDraggingTabId("")
    setDropTarget(undefined)
  }

  /**
   * TabItem
   * 参数：tab 会话标签；vertical 纵向布局（整行满宽、插入指示改上下方向）
   * 核心流程：色条 + 标题 + 关闭按钮；横向/纵向共用同一套拖拽、键盘与高亮逻辑，
   *           只在尺寸和插入指示方向上区分
   */
  function TabItem(props: { tab: ActiveSession; vertical: boolean }) {
    const active = () => currentSessionId() === props.tab.id
    // 标题编辑中：暂停拖拽与切标签，避免拖拽吞掉文本选择、点击打断输入
    const [renaming, setRenaming] = createSignal(false)
    return (
      <div
        data-session-tab={props.tab.id}
        draggable={!renaming()}
        onDragStart={(event) => startTabDrag(event, props.tab)}
        onDragOver={(event) => overTab(event, props.tab)}
        onDragLeave={() => {
          if (dropTarget()?.id === props.tab.id) setDropTarget(undefined)
        }}
        onDrop={(event) => dropTab(event, props.tab)}
        onDragEnd={endTabDrag}
        class="group relative flex min-w-0 items-center rounded-[6px] pr-1 transition-colors"
        classList={{
          "h-[26px] max-w-[220px] shrink-0": !props.vertical,
          "h-7 w-full": props.vertical,
          "bg-raised text-text": active(),
          "text-muted hover:bg-raised/60": !active(),
          "opacity-40": draggingTabId() === props.tab.id,
        }}
        style={{ "background-color": active() ? tabColor(props.tab)?.tint : undefined }}
      >
        {/* 拖拽插入位：横向画竖线，纵向画横线 */}
        <Show when={dropTarget()?.id === props.tab.id}>
          <span
            aria-hidden="true"
            class="pointer-events-none absolute rounded-full bg-accent"
            classList={{
              "top-0 bottom-0 w-[2px]": !props.vertical,
              "left-0 right-0 h-[2px]": props.vertical,
              "left-0": !props.vertical && dropTarget()?.after === false,
              "right-0": !props.vertical && dropTarget()?.after === true,
              "top-0": props.vertical && dropTarget()?.after === false,
              "bottom-0": props.vertical && dropTarget()?.after === true,
            }}
          />
        </Show>
        {/* 工作区色条：同一工作区固定同色，跨 tab 快速识别 */}
        <span
          aria-hidden="true"
          class="ml-1 h-3 w-[3px] shrink-0 rounded-full"
          style={{ "background-color": tabColor(props.tab)?.solid ?? "transparent" }}
        />
        <div
          role="tab"
          aria-selected={active()}
          tabIndex={rovingTabId() === props.tab.id ? 0 : -1}
          class="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[6px] pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title={props.tab.title}
          aria-label={`Open ${props.tab.title || "Untitled"}`}
          aria-current={active() ? "page" : undefined}
          onClick={() => {
            if (renaming()) return
            void openTab(props.tab)
          }}
          onKeyDown={(event) => {
            // div 没有 button 的原生回车/空格激活，这里补齐
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              void openTab(props.tab)
              return
            }
            onTabKeyDown(event, props.tab.id)
          }}
        >
          <span class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-accent text-[9px] font-bold leading-none text-white">
            C
          </span>
          {/* 运行中：该会话正在产出消息，转圈图标与时间线的运行指示呼应 */}
          <Show when={isSessionRunning(props.tab.id)}>
            <svg
              viewBox="0 0 16 16"
              class="size-3 shrink-0 animate-spin text-accent"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              role="status"
              aria-label="Running"
            >
              <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" stroke-linecap="round" />
            </svg>
          </Show>
          <InlineTitle
            value={props.tab.title || "Untitled"}
            class="min-w-0 flex-1 truncate text-[12px]"
            inputClass="min-w-0 flex-1 rounded-[4px] border border-edge bg-base px-1 text-[12px] text-text outline-none focus:border-accent"
            onEditingChange={setRenaming}
            onCommit={(next) => commitRename(props.tab, next)}
          />
          {/* 已完成未看：跑完但从没打开过这个会话，气泡会超时消失，角标要一直在 */}
          <Show when={!isSessionRunning(props.tab.id) && isSessionUnread(props.tab.id)}>
            <span class="mr-0.5 size-1.5 shrink-0 rounded-full bg-accent" role="status" aria-label="Unread completion" />
          </Show>
        </div>
        <button
          type="button"
          aria-label={`Close ${props.tab.title || "Untitled"}`}
          title="Close tab"
          class="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted opacity-0 transition-opacity hover:bg-edge-strong hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          classList={{ "opacity-100": active() }}
          onClick={() => closeTab(props.tab)}
        >
          <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div class="contents">
    <header
      class="flex h-9 shrink-0 flex-row items-center justify-between gap-2 border-b border-edge bg-deep pl-1.5 pr-2"
      classList={{ "col-start-2 row-start-1": vertical() }}
    >
      <div class="relative flex min-w-0 flex-1 items-center gap-1">
        {/* 主页按钮：图标按钮，回到首页 */}
        <button
          type="button"
          aria-label="Home"
          title="Home"
          class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={() => navigate("/")}
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="2.5" y="2.5" width="4" height="4" rx="0.8" />
            <rect x="9.5" y="2.5" width="4" height="4" rx="0.8" />
            <rect x="2.5" y="9.5" width="4" height="4" rx="0.8" />
            <rect x="9.5" y="9.5" width="4" height="4" rx="0.8" />
          </svg>
        </button>

        <Show when={openSessions().length === 0}>
          <span class="truncate px-1 text-[13px] font-semibold text-text">Crush</span>
        </Show>

        <Show when={!vertical()}>
        {/* 标签溢出时提供左右滚动，避免被隐藏的标签点不到 */}
        <Show when={canLeft()}>
          <button
            type="button"
            aria-label="Scroll tabs left"
            title="Scroll tabs left"
            class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={() => scrollTabs(-240)}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="m10 4-4 4 4 4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </Show>

        {/* 多会话标签：横向滚动，点击切换，关闭后自动跳到相邻标签 */}
        <div
          ref={attachStrip}
          onScroll={updateScrollState}
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <For each={tabGroups()}>
            {(group, groupIndex) => (
              <>
                <Show when={groupIndex() > 0}>
                  <span aria-hidden="true" class="mx-0.5 h-3.5 w-px shrink-0 bg-edge" />
                </Show>
                {/* 一个项目一组：组内标签紧邻，组首用项目色轨标记归属 */}
                <div
                  role="tablist"
                  aria-label={group.label}
                  title={group.label}
                  data-workspace-group={group.key}
                  class="flex min-w-0 shrink-0 items-center gap-1"
                >
                  <span
                    aria-hidden="true"
                    class="h-4 w-[2px] shrink-0 rounded-full"
                    style={{ "background-color": group.solid ?? "transparent" }}
                  />
                  <For each={group.tabs}>
                    {(tab) => (
              <TabItem tab={tab} vertical={false} />
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </div>

        <Show when={canRight()}>
          <button
            type="button"
            aria-label="Scroll tabs right"
            title="Scroll tabs right"
            class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={() => scrollTabs(240)}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </Show>

        {/* 全部标签：溢出时也能从菜单里选择或关闭 */}
        <Show when={canLeft() || canRight() || openSessions().length > 4}>
          <button
            type="button"
            aria-label="All tabs"
            title="All tabs"
            aria-expanded={tabsMenu()}
            class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={() => setTabsMenu((value) => !value)}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <Show when={tabsMenu()}>
            <div class="fixed inset-0 z-40" onClick={() => setTabsMenu(false)} />
            <div class="absolute top-8 right-2 z-50 w-72 overflow-hidden rounded-[8px] border border-edge bg-deep shadow-xl">
              <div class="border-b border-edge px-2.5 py-1.5 text-[10px] font-semibold tracking-wide text-faint uppercase">
                Open tabs
              </div>
              <div class="max-h-72 overflow-y-auto py-1">
                <For each={tabGroups()}>
                  {(group) => (
                    <>
                      <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">
                        <span
                          aria-hidden="true"
                          class="size-1.5 shrink-0 rounded-full"
                          style={{ "background-color": group.solid ?? "transparent" }}
                        />
                        <span class="min-w-0 flex-1 truncate">{group.label}</span>
                        <span class="shrink-0">{group.tabs.length}</span>
                      </div>
                      <For each={group.tabs}>
                        {(tab) => (
                    <div class="flex items-center gap-1 px-1">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
                        classList={{ "bg-raised text-text": currentSessionId() === tab.id }}
                        style={{ "background-color": currentSessionId() === tab.id ? tabColor(tab)?.tint : undefined }}
                        onClick={() => {
                          setTabsMenu(false)
                          void openTab(tab)
                        }}
                      >
                        {/* 与顶栏一致的工作区色点 */}
                        <span
                          aria-hidden="true"
                          class="size-1.5 shrink-0 rounded-full"
                          style={{ "background-color": tabColor(tab)?.solid ?? "transparent" }}
                        />
                        <span class="min-w-0 flex-1 truncate">{tab.title || "Untitled"}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${tab.title || "Untitled"}`}
                        class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted transition-colors hover:bg-edge-strong hover:text-text"
                        onClick={() => {
                          setTabsMenu(false)
                          closeTab(tab)
                        }}
                      >
                        <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
                        </svg>
                      </button>
                    </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>

        </Show>

        {/* 新建会话：单击/右键都先弹窗询问「新 tab」还是「覆盖当前 tab」 */}
        <div class="relative shrink-0">
          <button
            type="button"
            aria-label="New session"
            aria-haspopup="dialog"
            aria-expanded={newDialogOpen()}
            title="New session (Ctrl+Shift+N: replace current)"
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40"
            disabled={creating()}
            onClick={() => setNewDialogOpen(true)}
            onContextMenu={(event) => {
              event.preventDefault()
              setNewDialogOpen(true)
            }}
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
            </svg>
          </button>

          {/* 新建失败提示：保留当前会话，只用气泡告知原因 */}
          <Show when={createError()}>
            <div class="absolute right-0 top-8 z-50 w-56 rounded-xl border border-edge bg-base px-2.5 py-2 text-[11px] leading-4 text-[#e5484d] shadow-xl">
              {createError()}
            </div>
          </Show>
        </div>

        {/* 打开已有会话：从当前项目历史会话中选择并作为标签打开 */}
        <div class="relative">
          <button
            type="button"
            aria-label="Open session"
            title="Open session"
            aria-expanded={pickerOpen()}
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={() => void togglePicker()}
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke-linecap="round" />
            </svg>
          </button>
          <Show when={pickerOpen()}>
            <div class="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
            <div
              class="absolute top-8 right-0 z-50 w-80 overflow-hidden rounded-[8px] border border-edge bg-deep shadow-xl"
              onKeyDown={(event) => {
                if (event.key === "Escape") setPickerOpen(false)
              }}
            >
              <div class="border-b border-edge p-2">
                <input
                  ref={searchRef}
                  id="session-search"
                  name="session-search"
                  value={pickerQuery()}
                  onInput={(event) => setPickerQuery(event.currentTarget.value)}
                  placeholder="Search sessions"
                  class="w-full rounded-[6px] border border-edge bg-base px-2 py-1 text-[12px] text-text outline-none placeholder:text-faint focus:border-edge-strong"
                />
              </div>
              <div class="max-h-72 overflow-y-auto py-1">
                <Show when={pickerLoading()}>
                  <div class="px-3 py-2 text-[11px] text-faint">Loading sessions…</div>
                </Show>
                <Show when={!pickerLoading() && pickerError()}>
                  <div class="px-3 py-2 text-[11px] text-[#e5484d]">{pickerError()}</div>
                </Show>
                <Show when={!pickerLoading() && !pickerError() && filteredSessions().length === 0}>
                  <div class="px-3 py-2 text-[11px] text-faint">No sessions</div>
                </Show>
                {/* 已打开标签：按项目分组，跨项目也能直接跳转 */}
                <Show when={filteredTabGroups().length > 0}>
                  <div class="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">
                    Open tabs
                  </div>
                  <For each={filteredTabGroups()}>
                    {(group) => (
                      <>
                        <div class="flex items-center gap-1.5 px-3 py-1 text-[10px] text-faint">
                          <span
                            aria-hidden="true"
                            class="size-1.5 shrink-0 rounded-full"
                            style={{ "background-color": group.solid ?? "transparent" }}
                          />
                          <span class="min-w-0 flex-1 truncate">{group.label}</span>
                          <span class="shrink-0">{group.tabs.length}</span>
                        </div>
                        <For each={group.tabs}>
                          {(tab) => (
                            <button
                              type="button"
                              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
                              onClick={() => {
                                setPickerOpen(false)
                                void openTab(tab)
                              }}
                            >
                              <span class="min-w-0 flex-1 truncate">{tab.title || "Untitled"}</span>
                              <Show when={currentSessionId() === tab.id}>
                                <span class="shrink-0 text-[10px] text-accent">current</span>
                              </Show>
                            </button>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                  <div class="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">
                    History
                  </div>
                </Show>

                <For each={filteredSessions()}>
                  {(session) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
                      onClick={() => openExisting(session)}
                    >
                      <span class="min-w-0 flex-1 truncate">{session.title || "Untitled"}</span>
                      <Show when={currentSessionId() === session.id}>
                        <span class="shrink-0 text-[10px] text-accent">current</span>
                      </Show>
                      <span class="shrink-0 text-[10px] text-faint">{session.message_count ?? 0}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        {/* 前缀待命提示：Ctrl+B 之后告诉用户能按哪些键（方向键切标签、N 新建），2 秒后自动消失 */}
        <Show when={prefixActive()}>
          <span
            role="status"
            aria-label="Prefix active, press arrow key to switch tabs or N to create a session"
            class="flex shrink-0 items-center gap-1 rounded-[6px] border border-edge bg-raised px-1.5 py-0.5 text-[10px] text-muted"
          >
            <kbd class="font-sans text-accent">Ctrl+B</kbd>
            <span aria-hidden="true">→</span>
            <kbd class="font-sans text-text">{vertical() ? "↑/↓" : "←/→"}</kbd>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">N</kbd>
            <span class="text-faint">新建</span>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">G</kbd>
            <span class="text-faint">标签</span>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">Q</kbd>
            <span class="text-faint">提问</span>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">M</kbd>
            <span class="text-faint">模型</span>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">U</kbd>
            <span class="text-faint">压缩</span>
            <span class="text-faint" aria-hidden="true">·</span>
            <kbd class="font-sans text-text">?</kbd>
          </span>
        </Show>
        {/* 标签栏布局：横向/纵向切换，选择持久化到 localStorage */}
        <button
          type="button"
          aria-label={vertical() ? "Switch to horizontal tabs" : "Switch to vertical tabs"}
          title={vertical() ? "标签栏：切换为横向" : "标签栏：切换为纵向"}
          aria-pressed={vertical()}
          class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={() => toggleTabsOrientation()}
        >
          <Show
            when={vertical()}
            fallback={
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
                <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
                <path d="M6.5 3v10" />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
              <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
              <path d="M2.5 6.5h11" />
            </svg>
          </Show>
        </button>

        {/* 主题选择：下拉列出全部主题，选中即切换 */}
        <ThemeSelect />

        {/* 状态圆点：点击打开 MCP/LSP/Skills 浮层 */}
        <div class="relative">
          <button
            type="button"
            aria-label="Show server status"
            title={state() === "connected" ? "已连接后端" : "未连接后端"}
            class="flex size-7 items-center justify-center rounded-[6px] transition-colors hover:bg-raised"
            onClick={() => setStatusOpen((v) => !v)}
          >
            <span
              class="size-2 rounded-full transition-colors"
              classList={{
                "bg-[var(--status-connected)]": state() === "connected",
                "bg-[var(--status-disconnected)]": state() !== "connected",
              }}
            />
          </button>
          <Show when={statusOpen()}>
            <StatusPopover
              wsId={statusWsId()}
              connected={state() === "connected"}
              onClose={() => setStatusOpen(false)}
            />
          </Show>
        </div>
      </div>

      {/* 新建询问弹窗：默认新 tab，覆盖当前只在有当前会话时可选 */}
      <NewSessionDialog
        open={newDialogOpen()}
        currentTitle={currentTab()?.title}
        busy={creating()}
        onClose={() => setNewDialogOpen(false)}
        onChoose={(mode) => void handleNewSession(mode === "replace")}
      />
    </header>

      {/* 纵向标签栏：左侧独立栏，分组与横向模式一致 */}
      <Show when={vertical()}>
        <aside
          class="col-start-1 row-span-2 row-start-1 flex min-h-0 flex-col border-r border-edge bg-deep"
          aria-label="Session tabs"
        >
          <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge px-2.5">
            <span class="text-[10px] font-semibold tracking-wide text-faint uppercase">Tabs</span>
            <span class="text-[10px] text-faint">{openSessions().length}</span>
          </div>
          <Show
            when={openSessions().length > 0}
            fallback={<div class="px-2.5 py-2 text-[11px] text-faint">No open tabs</div>}
          >
            <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
              <For each={tabGroups()}>
                {(group) => (
                  <div class="mb-2 min-w-0" data-workspace-group={group.key}>
                    <div class="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">
                      <span
                        aria-hidden="true"
                        class="size-1.5 shrink-0 rounded-full"
                        style={{ "background-color": group.solid ?? "transparent" }}
                      />
                      <span class="min-w-0 flex-1 truncate" title={group.label}>
                        {group.label}
                      </span>
                      <span class="shrink-0">{group.tabs.length}</span>
                    </div>
                    <div role="tablist" aria-label={group.label} class="flex min-w-0 flex-col gap-0.5">
                      <For each={group.tabs}>{(tab) => <TabItem tab={tab} vertical={true} />}</For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </aside>
      </Show>
    </div>
  )
}

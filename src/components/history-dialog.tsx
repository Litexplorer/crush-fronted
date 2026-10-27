/**
 * history-dialog.tsx
 * 参数：无（开关与关闭函数来自全局 ui-store）
 * 核心流程：历史会话独立浮层 ——
 *           拉取当前工作区的全部会话并按更新时间倒序，顶部搜索按标题过滤，
 *           ↑↓ 选择、Enter 打开（登记为标签）、Esc 或点击遮罩关闭
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { closeHistoryDialog, historyDialogOpen, ensureSessionTab, openSessions } from "../lib/ui-store"
import { selectedWorkspace } from "../lib/workspace-store"
import { listSessions, type Session } from "../lib/sessions"
import { ensureLiveWorkspace, sessionUrl } from "../lib/session-actions"

/**
 * routeSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：提取 /session/:id 的最后一段并解码，用于标记当前会话
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

export default function HistoryDialog() {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  /** 防止旧请求覆盖新结果：每次加载自增 */
  let loadToken = 0

  const currentSessionId = () => routeSessionId(location.pathname)

  /** 当前工作区：优先取路由参数（服务端重启后可能已失效，加载失败时提示） */
  const workspaceId = createMemo(() => {
    const match = /^\/w\/([^/?#]+)/.exec(location.pathname)
    if (match) return decodeURIComponent(match[1])
    return selectedWorkspace()?.id
  })

  /**
   * load
   * 参数：wsId 工作区 ID
   * 核心流程：拉会话列表按更新时间倒序；丢弃过期响应；失败展示原因而不是空白列表
   */
  async function load(wsId: string) {
    const token = ++loadToken
    setLoading(true)
    setError("")
    try {
      const list = await listSessions(wsId)
      if (token !== loadToken) return
      setSessions([...list].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)))
    } catch (err) {
      if (token !== loadToken) return
      setSessions([])
      setError(err instanceof Error ? err.message : "会话列表加载失败")
    } finally {
      if (token === loadToken) setLoading(false)
    }
  }

  // 打开时重置搜索与高亮，重新加载列表，并把焦点交给搜索框
  createEffect(() => {
    if (!historyDialogOpen()) return
    setQuery("")
    setActiveIndex(0)
    const wsId = workspaceId()
    if (wsId) void load(wsId)
    queueMicrotask(() => inputRef?.focus())
  })

  /**
   * filtered
   * 参数：无
   * 核心流程：按标题过滤（不区分大小写），保证列表与键盘下标使用同一份顺序
   */
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return sessions()
    return sessions().filter((session) => (session.title || "Untitled").toLowerCase().includes(needle))
  })

  /**
   * openSession
   * 参数：session 选中的历史会话
   * 核心流程：按项目路径解析有效工作区 → 登记为标签（保留项目路径）→ 关闭浮层 → 跳转
   */
  async function openSession(session: Session) {
    const wsId = workspaceId()
    if (!wsId) return
    const projectPath = openSessions().find((tab) => tab.workspaceId === wsId)?.projectPath ?? selectedWorkspace()?.path
    const liveId = await ensureLiveWorkspace(projectPath, wsId)
    const target = {
      id: session.id,
      title: session.title || "Untitled",
      workspaceId: liveId ?? wsId,
      projectPath,
    }
    ensureSessionTab(target)
    closeHistoryDialog()
    navigate(sessionUrl(target))
  }

  /**
   * moveActive
   * 参数：delta 相对位移
   * 核心流程：在过滤结果里上下移动高亮并首尾循环
   */
  function moveActive(delta: number) {
    const total = filtered().length
    if (total === 0) return
    setActiveIndex((prev) => (prev + delta + total) % total)
  }

  // 高亮项滚动进视野：历史会话可能很多
  createEffect(() => {
    const index = activeIndex()
    if (!historyDialogOpen()) return
    queueMicrotask(() => {
      listRef?.querySelector<HTMLElement>(`[data-history-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：打开时 Esc 关闭；方向键在搜索框的 onKeyDown 里处理
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!historyDialogOpen() || event.key !== "Escape") return
      event.preventDefault()
      closeHistoryDialog()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  /**
   * handleInputKeyDown
   * 参数：event 搜索框键盘事件
   * 核心流程：↑↓ 移动高亮、Enter 打开当前项；输入法组词时不拦截
   */
  function handleInputKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    const target = filtered()[activeIndex()]
    if (target) void openSession(target)
  }

  return (
    <Show when={historyDialogOpen()}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]" onClick={closeHistoryDialog}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Session history"
          class="flex max-h-[64vh] w-[440px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputRef}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索历史会话…"
            aria-label="Search session history"
            class="h-10 w-full shrink-0 border-b border-edge bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" aria-label="Session history" class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={filtered()}>
              {(session, index) => {
                const active = () => index() === activeIndex()
                const current = () => session.id === currentSessionId()
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active()}
                    data-history-index={index()}
                    data-history-session={session.id}
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                    classList={{
                      "bg-raised text-text": active(),
                      "text-muted hover:bg-raised/60": !active(),
                    }}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => void openSession(session)}
                  >
                    {/* 更新时间：历史会话的重要排序依据 */}
                    <span class="shrink-0 text-[10px] text-faint">{formatUpdated(session.updated_at)}</span>
                    <span class="min-w-0 flex-1 truncate">{session.title || "Untitled"}</span>
                    <Show when={session.is_busy}>
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
                    <Show when={current()}>
                      <span class="shrink-0 text-[10px] text-accent">current</span>
                    </Show>
                    <span class="shrink-0 text-[10px] text-faint">{session.message_count ?? 0}</span>
                  </button>
                )
              }}
            </For>
            <Show when={!loading() && filtered().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">{error() || "没有匹配的会话"}</p>
            </Show>
            <Show when={loading() && filtered().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">加载会话中…</p>
            </Show>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            <span>{sessions().length} 个历史会话</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

/**
 * formatUpdated
 * 参数：seconds 秒级时间戳（proto.Session.updated_at）
 * 核心流程：换算成相对时间（刚刚 / N 分钟 / N 小时 / N 天），缺失时留空
 */
function formatUpdated(seconds: number | undefined): string {
  if (!seconds) return ""
  const diff = Date.now() / 1000 - seconds
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

/**
 * titlebar.tsx
 * 参数：无
 * 核心流程：36px 顶栏（复刻 opencode 版式）——
 *           左侧：主页按钮 + 当前会话标签页（可关闭）+ 新建会话按钮
 *           右侧：主题切换按钮 + 后端连接状态圆点（GET /v1/health 轮询）
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { createSession } from "../lib/sessions"
import { selectedWorkspace } from "../lib/workspace-store"
import {
  activeSession,
  closeSessionTab,
  openSessions,
  setActiveSession,
  setTheme,
  theme,
  type ActiveSession,
} from "../lib/ui-store"
import StatusPopover from "./status-popover"

type ConnectionState = "connected" | "disconnected"

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

/** 会话页地址 */
function sessionUrl(tab: ActiveSession): string {
  return `/w/${encodeURIComponent(tab.workspaceId)}/session/${encodeURIComponent(tab.id)}`
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
  const [statusOpen, setStatusOpen] = createSignal(false)
  // 当前路由对应的会话标签：用于高亮与工作区回退
  const currentSessionId = () => routeSessionId(location.pathname)
  const currentTab = () => openSessions().find((tab) => tab.id === currentSessionId())
  // 状态浮层数据源：当前会话所属工作区，回退到首页选中项
  const statusWsId = () => currentTab()?.workspaceId ?? selectedWorkspace()?.id ?? activeSession()?.workspaceId

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

  /**
   * handleNewSession
   * 参数：无（读取当前会话/选中工作区）
   * 核心流程：确定 workspace → POST 新建会话 → 跳转会话页；失败静默回首页
   */
  async function handleNewSession() {
    const wsId = currentTab()?.workspaceId ?? selectedWorkspace()?.id ?? activeSession()?.workspaceId
    if (!wsId || creating()) {
      navigate("/")
      return
    }
    setCreating(true)
    try {
      // 新建会话：成功后进入新会话，由会话页追加标签
      const created = await createSession(wsId)
      navigate(sessionUrl({ id: created.id, title: "Untitled", workspaceId: wsId }))
    } catch {
      // 新建失败：回到首页由页面给出可见错误
      navigate(`/w/${encodeURIComponent(wsId)}`)
    }
    setCreating(false)
  }

  /**
   * openTab
   * 参数：tab 目标会话标签
   * 核心流程：设为当前会话并跳转到对应会话页
   */
  function openTab(tab: ActiveSession) {
    setActiveSession(tab)
    navigate(sessionUrl(tab))
  }

  /**
   * closeTab
   * 参数：tab 要关闭的标签
   * 核心流程：从标签列表移除；若关闭的是当前路由会话，
   *           跳转到相邻标签，没有相邻标签则回工作区首页
   */
  function closeTab(tab: ActiveSession) {
    const closingActiveRoute = currentSessionId() === tab.id
    const next = closeSessionTab(tab.id)
    if (!closingActiveRoute) return
    if (next) navigate(sessionUrl(next))
    else navigate(`/w/${encodeURIComponent(tab.workspaceId)}`)
  }

  return (
    <header class="flex h-9 shrink-0 flex-row items-center justify-between gap-2 border-b border-edge bg-deep pl-1.5 pr-2">
      <div class="flex min-w-0 flex-1 items-center gap-1">
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

        {/* 多会话标签：横向滚动，点击切换，关闭后自动跳到相邻标签 */}
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <For each={openSessions()}>
            {(tab) => (
              <div
                data-session-tab={tab.id}
                class="group flex h-[26px] max-w-[220px] min-w-0 shrink-0 items-center rounded-[6px] pr-1 transition-colors"
                classList={{
                  "bg-raised text-text": currentSessionId() === tab.id,
                  "text-muted hover:bg-raised/60": currentSessionId() !== tab.id,
                }}
              >
                <button
                  type="button"
                  class="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left"
                  title={tab.title}
                  aria-label={`Open ${tab.title || "Untitled"}`}
                  aria-current={currentSessionId() === tab.id ? "page" : undefined}
                  onClick={() => openTab(tab)}
                >
                  <span class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-accent text-[9px] font-bold leading-none text-white">
                    C
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[12px]">{tab.title || "Untitled"}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title || "Untitled"}`}
                  title="Close tab"
                  class="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted opacity-0 transition-opacity hover:bg-edge-strong hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => closeTab(tab)}
                >
                  <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            )}
          </For>
        </div>

        {/* 新建会话：始终可用；无工作区时回首页 */}
        <button
          type="button"
          aria-label="New session"
          title="New session"
          class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40"
          disabled={creating()}
          onClick={() => void handleNewSession()}
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        {/* 主题切换：dark/light，持久化到 localStorage */}
        <button
          type="button"
          aria-label={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          class="flex size-7 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}
        >
          <Show
            when={theme() === "dark"}
            fallback={
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
                <circle cx="8" cy="8" r="2.6" />
                <path
                  d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"
                  stroke-linecap="round"
                />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M13.2 9.6A5.4 5.4 0 1 1 6.4 2.8a4.4 4.4 0 0 0 6.8 6.8Z" stroke-linejoin="round" />
            </svg>
          </Show>
        </button>

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
    </header>
  )
}

/**
 * notification-center.tsx
 * 参数：无
 * 核心流程：右下角「会话跑完了」气泡堆 ——
 *           每条展示状态色点 + 会话标题 + 尾部回复摘要；
 *           点击气泡跳到对应会话（跳转后由通知表接管 10 秒倒计时），
 *           也可手动关闭；同时把当前路由上的会话同步给通知表，
 *           让它知道哪些气泡该倒计时、哪些该常驻
 */
import { For, createEffect, on } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { dismissNotification, notifications, setViewingSession, type SessionNotification } from "../lib/notifications"
import { ensureLiveWorkspace, sessionUrl } from "../lib/session-actions"
import { openSessions, setActiveSession } from "../lib/ui-store"

/** 状态对应的色点与文字 */
const STATUS_STYLE: Record<SessionNotification["status"], { dot: string; label: string; tone: string }> = {
  done: { dot: "bg-accent", label: "已完成", tone: "text-accent" },
  error: { dot: "bg-[#e5484d]", label: "出错", tone: "text-[#e5484d]" },
  cancelled: { dot: "bg-faint", label: "已取消", tone: "text-muted" },
}

/**
 * currentSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：从 /w/<ws>/session/<id> 里取会话 ID，非会话页返回 undefined，
 *           通知表据此决定气泡是倒计时还是常驻
 */
function currentSessionId(pathname: string): string | undefined {
  const match = /^\/w\/[^/]+\/session\/([^/?#]+)/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : undefined
}

export default function NotificationCenter() {
  const location = useLocation()
  const navigate = useNavigate()

  // 路由变化：正在看的会话开始 10 秒倒计时，离开的会话暂停并保持常驻
  // 显式声明依赖，避免函数内部读到通知表导致每次新通知都重跑同步逻辑
  createEffect(on(() => location.pathname, (pathname) => setViewingSession(currentSessionId(pathname))))

  /**
   * open
   * 参数：item 被点击的通知
   * 核心流程：按会话 ID 找回标签（关闭过则直接丢弃通知）→ 解析有效工作区
   *           → 设为当前会话并跳转；不在此处删除通知，交给跳转后的倒计时
   */
  async function open(item: SessionNotification) {
    const tab = openSessions().find((candidate) => candidate.id === item.sessionId)
    if (!tab) {
      dismissNotification(item.sessionId)
      return
    }
    const workspaceId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: workspaceId ?? tab.workspaceId }
    setActiveSession(target)
    navigate(sessionUrl(target))
  }

  return (
    <div
      class="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[320px] flex-col-reverse gap-2"
      role="region"
      aria-label="Session notifications"
      aria-live="polite"
    >
      <For each={notifications()}>
        {(item) => {
          const style = () => STATUS_STYLE[item.status]
          return (
            <div
              class="pointer-events-auto group relative flex cursor-pointer items-start gap-2 rounded-xl border border-edge bg-base/95 p-3 pr-8 shadow-xl backdrop-blur transition-colors hover:border-edge-strong"
              role="button"
              tabIndex={0}
              aria-label={`${item.title} ${style().label}`}
              onClick={() => void open(item)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                void open(item)
              }}
            >
              <span class={`mt-1 size-1.5 shrink-0 rounded-full ${style().dot}`} aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{item.title}</span>
                  <span class={`shrink-0 text-[10px] ${style().tone}`}>{style().label}</span>
                </div>
                <p class="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">{item.detail}</p>
              </div>
              <button
                type="button"
                aria-label={`Dismiss ${item.title} notification`}
                title="Dismiss"
                class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-edge-strong hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  dismissNotification(item.sessionId)
                }}
              >
                <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}

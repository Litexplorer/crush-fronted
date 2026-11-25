/**
 * mascot-dock.tsx
 * 参数：无
 * 核心流程：右下角「小鲸」气泡坞 ——
 *           常驻立绘，有通知时在她上方说一句（逐字输出，说话时换思考立绘）；
 *           会话类通知可点击跳转，提示类只展示不可点；
 *           悬停暂停自动消失计时，离开继续；报错气泡不自动消失；
 *           立绘与文字只读通知表，倒计时/未读圆点仍由 lib/notifications 负责
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import {
  dismissBubble,
  dismissTip,
  notifications,
  pauseBubble,
  resumeBubble,
  setViewingSession,
  type SessionNotification,
} from "../lib/notifications"
import { ensureLiveWorkspace, sessionUrl } from "../lib/session-actions"
import { openSessions, setActiveSession } from "../lib/ui-store"
import idleUrl from "../assets/mascot/idle.webp"
import thinkingUrl from "../assets/mascot/thinking.webp"
import doneUrl from "../assets/mascot/done.webp"
import errorUrl from "../assets/mascot/error.webp"

/** 状态 → 立绘。取消与提示都用待机图 */
const AVATAR: Record<SessionNotification["status"], string> = {
  done: doneUrl,
  error: errorUrl,
  cancelled: idleUrl,
  tip: idleUrl,
}

/** 状态 → 称呼与色调 */
const VOICE: Record<SessionNotification["status"], { name: string; tone: string }> = {
  done: { name: "小鲸", tone: "text-accent" },
  error: { name: "小鲸", tone: "text-[#e5484d]" },
  cancelled: { name: "小鲸", tone: "text-muted" },
  tip: { name: "小鲸", tone: "text-muted" },
}

/** 逐字输出间隔（毫秒） */
const TYPE_INTERVAL_MS = 18

/**
 * currentSessionId
 * 参数：pathname 当前路由路径
 * 核心流程：从 /w/<ws>/session/<id> 取会话 ID，非会话页返回 undefined
 */
function currentSessionId(pathname: string): string | undefined {
  const match = /^\/w\/[^/]+\/session\/([^/?#]+)/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : undefined
}

export default function MascotDock() {
  const location = useLocation()
  const navigate = useNavigate()
  const [typed, setTyped] = createSignal(0)
  const reduceMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false

  // 路由变化 → 通知表知道「用户已经在看这个会话」，据此消未读圆点并关掉它的气泡
  createEffect(on(() => location.pathname, (pathname) => setViewingSession(currentSessionId(pathname))))

  /** 最新一条通知：队列按新到旧排列，取头部即可 */
  const current = createMemo(() => notifications()[0])
  /** 剩余待播条数，用于角标 */
  const pending = createMemo(() => Math.max(0, notifications().length - 1))
  const status = createMemo(() => current()?.status ?? "cancelled")
  const voice = createMemo(() => VOICE[status()])

  // 新通知到达：从头逐字输出；关闭动效时直接显示全文
  createEffect(
    on(
      () => current()?.createdAt,
      () => {
        const detail = current()?.detail ?? ""
        if (reduceMotion || !detail) {
          setTyped(detail.length)
          return
        }
        setTyped(0)
        const timer = window.setInterval(() => {
          setTyped((count) => {
            if (count >= detail.length) {
              window.clearInterval(timer)
              return count
            }
            return count + 1
          })
        }, TYPE_INTERVAL_MS)
        onCleanup(() => window.clearInterval(timer))
      },
    ),
  )

  const typing = createMemo(() => typed() < (current()?.detail.length ?? 0))
  /** 说话时换思考立绘，说完回到状态立绘 */
  const avatar = createMemo(() => (typing() ? thinkingUrl : AVATAR[status()]))
  const text = createMemo(() => (current()?.detail ?? "").slice(0, typed()))

  /**
   * open
   * 参数：item 被点击的通知
   * 核心流程：提示类不跳转 → 会话类按 ID 找回标签（关掉过就丢弃通知）
   *           → 解析有效工作区 → 设为当前会话并跳转
   */
  async function open(item: SessionNotification) {
    if (item.kind !== "session" || !item.sessionId) return
    const tab = openSessions().find((candidate) => candidate.id === item.sessionId)
    if (!tab) {
      dismissBubble(item.sessionId)
      return
    }
    dismissBubble(item.sessionId)
    const workspaceId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: workspaceId ?? tab.workspaceId }
    setActiveSession(target)
    navigate(sessionUrl(target))
  }

  return (
    <div
      class="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
      role="region"
      aria-label="Mascot notifications"
      aria-live="polite"
    >
      <Show when={current()}>
        {(item) => (
          <div
            class="pointer-events-auto group relative max-w-[300px] rounded-xl border border-edge bg-base/95 px-3 py-2 pr-7 shadow-xl backdrop-blur transition-colors hover:border-edge-strong"
            classList={{ "cursor-pointer": item().kind === "session" }}
            role={item().kind === "session" ? "button" : "status"}
            tabIndex={item().kind === "session" ? 0 : undefined}
            aria-label={`${item().title} ${voice().name}`}
            onClick={() => void open(item())}
            onKeyDown={(event) => {
              if (item().kind !== "session") return
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              void open(item())
            }}
            onMouseEnter={() => pauseBubble(item().sessionId)}
            onMouseLeave={() => resumeBubble(item().sessionId)}
          >
            <div class="flex items-center gap-1.5">
              <span class={`shrink-0 text-[10px] font-medium ${voice().tone}`}>{voice().name}</span>
              <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{item().title}</span>
              <Show when={pending() > 0}>
                <span class="shrink-0 rounded-full bg-raised px-1.5 text-[10px] text-muted">+{pending()}</span>
              </Show>
            </div>
            <p class="mt-0.5 line-clamp-2 min-h-4 text-[11px] leading-4 text-muted" aria-hidden="true">
              {text()}
              <Show when={typing()}>
                <span class="animate-pulse" aria-hidden="true">
                  ▌
                </span>
              </Show>
            </p>
            {/* 读屏用完整文案：逐字输出只做视觉，避免 aria-live 逐字符播报 */}
            <span class="sr-only">{item().detail}</span>
            {/* 气泡小尾巴：指向下方立绘 */}
            <span class="absolute -bottom-[5px] right-6 size-2 rotate-45 border-b border-r border-edge bg-base" aria-hidden="true" />
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-edge-strong hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                if (item().kind === "session") dismissBubble(item().sessionId)
                else dismissTip()
              }}
            >
              <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        )}
      </Show>

      <img
        src={avatar()}
        alt=""
        aria-hidden="true"
        class="pointer-events-none size-[72px] select-none rounded-xl object-contain opacity-70 transition-opacity duration-200 mascot-float md:size-[216px]"
        classList={{ "opacity-100": Boolean(current()) }}
      />
    </div>
  )
}

/**
 * mascot-dock.tsx
 * 参数：无
 * 核心流程：右下角「小鲸」气泡坞 ——
 *           常驻立绘，有通知时在她上方说一句（逐字输出，说话时换思考立绘）；
 *           点击立绘进入互动：循环切换状态并说一句台词（本地气泡，不写通知表），
 *           台词期间暂停当前通知的自动消失计时，收起后恢复；
 *           会话类通知可点击跳转，提示类只展示不可点；
 *           悬停暂停自动消失计时，离开继续；报错气泡不自动消失
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

/** 点击互动时循环展示的立绘状态（与通知状态解耦） */
type MascotMood = "idle" | "thinking" | "done" | "error"

/** 点击顺序：待机 → 思考 → 完成 → 出错 → 待机 */
const MOOD_ORDER: MascotMood[] = ["idle", "thinking", "done", "error"]

/** 互动状态 → 立绘 */
const MOOD_AVATAR: Record<MascotMood, string> = {
  idle: idleUrl,
  thinking: thinkingUrl,
  done: doneUrl,
  error: errorUrl,
}

/** 互动状态 → 台词（点击时逐字说一句） */
const MOOD_LINES: Record<MascotMood, string> = {
  idle: "戳我干嘛呀…我在发呆呢。",
  thinking: "唔……让我想想。",
  done: "搞定啦，收工！",
  error: "哇，出错了，别看我…",
}

/** 互动状态 → 气泡色调 */
const MOOD_TONE: Record<MascotMood, string> = {
  idle: "text-muted",
  thinking: "text-accent",
  done: "text-accent",
  error: "text-[#e5484d]",
}

/** 互动气泡自动收起时长（毫秒） */
const MOOD_LINE_TTL_MS = 6000

/** 状态 → 称呼与色调 */
const VOICE: Record<SessionNotification["status"], { name: string; tone: string }> = {
  done: { name: "小鲸", tone: "text-accent" },
  error: { name: "小鲸", tone: "text-[#e5484d]" },
  cancelled: { name: "小鲸", tone: "text-muted" },
  tip: { name: "小鲸", tone: "text-muted" },
}

/** 逐字输出间隔（毫秒） */
const TYPE_INTERVAL_MS = 18

/** 当前气泡：通知（session/tip）与点击互动台词（line）共用一套渲染 */
interface Bubble {
  /** 逐字输出重启用的标识 */
  key: string
  kind: "session" | "tip" | "line"
  title: string
  detail: string
  tone: string
  sessionId?: string
}

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

  /** 点击互动选中的立绘状态；null 表示回到通知驱动的默认状态 */
  const [mood, setMood] = createSignal<MascotMood | null>(null)
  /** 点击互动的本地气泡（不进通知表，不影响未读） */
  const [line, setLine] = createSignal<{ state: MascotMood; detail: string; seq: number; at: number } | null>(null)
  let lineSeq = 0
  let lineTimer: number | undefined
  /** 互动台词占用气泡期间，被暂停计时的通知会话 */
  let pausedSessionId = ""

  /**
   * clearLine
   * 参数：无
   * 核心流程：收起本地台词气泡 → 清计时 → 恢复被暂停的通知自动消失计时
   */
  function clearLine() {
    if (lineTimer) {
      window.clearTimeout(lineTimer)
      lineTimer = undefined
    }
    setLine(null)
    if (pausedSessionId) {
      resumeBubble(pausedSessionId)
      pausedSessionId = ""
    }
  }

  onCleanup(() => {
    if (lineTimer) window.clearTimeout(lineTimer)
    if (pausedSessionId) resumeBubble(pausedSessionId)
  })

  /**
   * speech
   * 参数：无
   * 核心流程：点击台词优先，其次通知队列头部 →
   *           结果：气泡标题/正文/色调/是否可点由这一处统一决定
   */
  const speech = createMemo<Bubble | undefined>(() => {
    const local = line()
    // 台词展示期间若来了更新的通知，先播通知，台词留到通知消失后再说
    if (local && !(current() && current()!.createdAt > local.at)) {
      return {
        key: `line:${local.seq}`,
        kind: "line",
        title: "",
        detail: local.detail,
        tone: MOOD_TONE[local.state],
      }
    }
    const item = current()
    if (!item) return undefined
    return {
      key: `notif:${item.createdAt}:${item.sessionId}`,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      tone: VOICE[item.status].tone,
      sessionId: item.sessionId,
    }
  })

  // 新气泡（通知或点击台词）：从头逐字输出；关闭动效时直接显示全文
  createEffect(
    on(
      () => speech()?.key,
      () => {
        const detail = speech()?.detail ?? ""
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

  const typing = createMemo(() => typed() < (speech()?.detail.length ?? 0))
  /** 说话时换思考立绘，说完回到状态立绘；点击选中的状态优先于通知状态 */
  const avatar = createMemo(() => {
    const local = line()
    if (local) return MOOD_AVATAR[local.state]
    if (typing()) return thinkingUrl
    const selected = mood()
    return selected ? MOOD_AVATAR[selected] : AVATAR[current()?.status ?? "cancelled"]
  })
  const text = createMemo(() => (speech()?.detail ?? "").slice(0, typed()))

  /**
   * cycleMood
   * 参数：无
   * 核心流程：按 MOOD_ORDER 取当前状态的下一项 → 写入立绘状态 + 本地台词气泡 →
   *           暂停当前通知的自动消失计时并安排台词自动收起
   */
  function cycleMood() {
    const currentIndex = MOOD_ORDER.indexOf(mood() ?? "idle")
    const next = MOOD_ORDER[(currentIndex + 1) % MOOD_ORDER.length]
    setMood(next)
    setLine({ state: next, detail: MOOD_LINES[next], seq: ++lineSeq, at: Date.now() })

    const item = current()
    if (!pausedSessionId && item?.sessionId) {
      pausedSessionId = item.sessionId
      pauseBubble(item.sessionId)
    }
    if (lineTimer) window.clearTimeout(lineTimer)
    lineTimer = window.setTimeout(() => clearLine(), MOOD_LINE_TTL_MS)
  }

  /**
   * open
   * 参数：sessionId 目标会话 ID
   * 核心流程：按 ID 找回标签（关掉过就丢弃通知）→ 解析有效工作区
   *           → 设为当前会话并跳转
   */
  async function open(sessionId: string | undefined) {
    if (!sessionId) return
    const tab = openSessions().find((candidate) => candidate.id === sessionId)
    if (!tab) {
      dismissBubble(sessionId)
      return
    }
    dismissBubble(sessionId)
    const workspaceId = await ensureLiveWorkspace(tab.projectPath, tab.workspaceId)
    const target = { ...tab, workspaceId: workspaceId ?? tab.workspaceId }
    setActiveSession(target)
    navigate(sessionUrl(target))
  }

  /**
   * dismissBubbleItem
   * 参数：bubble 当前气泡
   * 核心流程：按气泡类型分别收起 —— 互动台词只清本地气泡，
   *           会话通知清队列，提示走 dismissTip
   */
  function dismissBubbleItem(bubble: Bubble) {
    if (bubble.kind === "line") {
      clearLine()
      return
    }
    if (bubble.kind === "session") {
      dismissBubble(bubble.sessionId ?? "")
      return
    }
    dismissTip()
  }

  return (
    <div
      class="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
      role="region"
      aria-label="Mascot notifications"
      aria-live="polite"
    >
      <Show when={speech()}>
        {(bubble) => (
          <div
            class="pointer-events-auto group relative max-w-[300px] rounded-xl border border-edge bg-base/95 px-3 py-2 pr-7 shadow-xl backdrop-blur transition-colors hover:border-edge-strong"
            classList={{ "cursor-pointer": bubble().kind === "session" }}
            role={bubble().kind === "session" ? "button" : "status"}
            tabIndex={bubble().kind === "session" ? 0 : undefined}
            aria-label={bubble().kind === "session" ? `${bubble().title} 小鲸` : undefined}
            onClick={() => {
              if (bubble().kind === "session") void open(bubble().sessionId)
              else if (bubble().kind === "line") clearLine()
            }}
            onKeyDown={(event) => {
              if (bubble().kind !== "session") return
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              void open(bubble().sessionId)
            }}
            onMouseEnter={() => {
              if (bubble().kind === "session") pauseBubble(bubble().sessionId ?? "")
            }}
            onMouseLeave={() => {
              if (bubble().kind === "session") resumeBubble(bubble().sessionId ?? "")
            }}
          >
            <div class="flex items-center gap-1.5">
              <span class={`shrink-0 text-[10px] font-medium ${bubble().tone}`}>小鲸</span>
              <Show when={bubble().title}>
                <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{bubble().title}</span>
              </Show>
              <Show when={bubble().kind !== "line" && pending() > 0}>
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
            <span class="sr-only">{bubble().detail}</span>
            {/* 气泡小尾巴：指向下方立绘 */}
            <span class="absolute -bottom-[5px] right-6 size-2 rotate-45 border-b border-r border-edge bg-base" aria-hidden="true" />
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-edge-strong hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                dismissBubbleItem(bubble())
              }}
            >
              <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        )}
      </Show>

      <button
        type="button"
        class="pointer-events-auto rounded-xl outline-none transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-label="小鲸：点一下换个状态"
        title="点一下换个状态"
        onClick={() => cycleMood()}
      >
        <img
          src={avatar()}
          alt=""
          aria-hidden="true"
          class="size-[72px] select-none rounded-xl object-contain opacity-70 transition-opacity duration-200 mascot-float md:size-[216px]"
          classList={{ "opacity-100": Boolean(current()) || Boolean(mood()) }}
        />
      </button>
    </div>
  )
}

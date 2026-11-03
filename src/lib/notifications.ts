/**
 * notifications.ts
 * 核心流程：全局「会话跑完了」通知表 ——
 *           SSE 收到 run_complete 且该会话已有标签时入队（同一会话覆盖去重）；
 *           气泡只在屏幕上停 10 秒，不论当前在哪个页面；
 *           没看过的结果靠标签上的未读圆点留痕，圆点只在真正打开该会话时消掉
 */
import { createSignal } from "solid-js"
import { subscribeEvents } from "./events"
import { playNotificationSound } from "./notification-sound"
import { activeSession, openSessions } from "./ui-store"

/** 通知状态：done 正常完成 / error 报错 / cancelled 被取消 */
export type NotificationStatus = "done" | "error" | "cancelled"

export interface SessionNotification {
  /** 会话 ID，同时用作去重键：同一会话只保留最后一条 */
  sessionId: string
  /** 会话标题，取自标签表 */
  title: string
  /** 尾部回复摘要，用于气泡正文 */
  detail: string
  status: NotificationStatus
  /** 入队时间戳（毫秒） */
  createdAt: number
}

/** 气泡停留时长：任何页面都只保留这么久，不留常驻气泡 */
export const NOTIFICATION_TTL_MS = 10_000
/** 通知表最多保留条数，超出丢弃最旧的 */
const MAX_NOTIFICATIONS = 5
/** 摘要正文最大字符数 */
const MAX_DETAIL_CHARS = 120

const [notifications, setNotifications] = createSignal<SessionNotification[]>([])
const [viewingSessionId, setViewingSessionIdRaw] = createSignal<string | undefined>(undefined)
/** 有「已完成但没看」结果的会话：标签上打角标用，独立于气泡（气泡会消失、会被覆盖） */
const [unreadSessions, setUnreadSessions] = createSignal<ReadonlySet<string>>(new Set())

/** 会话完成后是否弹通知：供未来加开关用，默认开 */
const [notifyEnabled] = createSignal(true)

/** 每条通知的自动消失计时器，键为会话 ID */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export { notifications, viewingSessionId }

/**
 * summarize
 * 参数：text 尾部回复全文
 * 核心流程：压缩空白、截断超长文本；空内容回落为「运行结束」，
 *           保证气泡正文永远有一行可读信息
 */
function summarize(text: string | undefined, status: NotificationStatus): string {
  const plain = (text ?? "").replace(/\s+/g, " ").trim()
  if (!plain) {
    if (status === "error") return "运行出错"
    if (status === "cancelled") return "运行已取消"
    return "运行结束"
  }
  return plain.length > MAX_DETAIL_CHARS ? `${plain.slice(0, MAX_DETAIL_CHARS)}…` : plain
}

/**
 * findTab
 * 参数：sessionId 会话 ID
 * 核心流程：先从打开的标签里找（拿标题与工作区），找不到再退回当前会话；
 *           都找不到说明这个会话不是本页发起的，直接不弹
 */
function findTab(sessionId: string) {
  return openSessions().find((tab) => tab.id === sessionId) ?? (activeSession()?.id === sessionId ? activeSession() : undefined)
}

/**
 * clearTimer
 * 参数：sessionId 会话 ID
 * 核心流程：取消该会话的自动消失计时（离开当前会话时暂停倒计时）
 */
function clearTimer(sessionId: string) {
  const timer = timers.get(sessionId)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(sessionId)
}

/**
 * isSessionUnread
 * 参数：sessionId 会话 ID
 * 核心流程：查未读集合，供标签栏渲染「已完成未看」角标
 */
export function isSessionUnread(sessionId: string): boolean {
  return unreadSessions().has(sessionId)
}

/**
 * markUnread
 * 参数：sessionId 会话 ID；unread 是否标为未读
 * 核心流程：幂等增删未读集合；集合未变化时不触发信号更新，避免多余重渲染
 */
function markUnread(sessionId: string, unread: boolean) {
  if (!sessionId) return
  setUnreadSessions((prev) => {
    if (prev.has(sessionId) === unread) return prev
    const next = new Set(prev)
    if (unread) next.add(sessionId)
    else next.delete(sessionId)
    return next
  })
}

/**
 * dismissBubble
 * 参数：sessionId 会话 ID
 * 核心流程：只关气泡并清掉倒计时，保留标签上的未读圆点 ——
 *           圆点只由「真正打开该会话」消掉，关不关气泡不影响它
 */
export function dismissBubble(sessionId: string) {
  clearTimer(sessionId)
  setNotifications((prev) => (prev.some((item) => item.sessionId === sessionId) ? prev.filter((item) => item.sessionId !== sessionId) : prev))
}

/**
 * dismissNotification
 * 参数：sessionId 会话 ID
 * 核心流程：关气泡并消掉未读圆点；只在「通知已彻底失去意义」时使用（如标签被关闭）
 */
export function dismissNotification(sessionId: string) {
  dismissBubble(sessionId)
  markUnread(sessionId, false)
}

/**
 * startDismissTimer
 * 参数：sessionId 会话 ID
 * 核心流程：每个气泡都只活 10 秒，不论当前停在哪个页面；
 *           没看过的结果由标签上的未读圆点留痕，气泡不再常驻
 */
function startDismissTimer(sessionId: string) {
  clearTimer(sessionId)
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      dismissBubble(sessionId)
    }, NOTIFICATION_TTL_MS),
  )
}

/**
 * setViewingSession
 * 参数：sessionId 当前打开的会话（不在会话页时为 undefined）
 * 核心流程：进入某会话即消掉它的未读圆点并关掉它的气泡（已经在看，不需要提示）
 */
export function setViewingSession(sessionId: string | undefined) {
  if (viewingSessionId() === sessionId) return
  setViewingSessionIdRaw(sessionId)
  if (!sessionId) return
  markUnread(sessionId, false)
  dismissBubble(sessionId)
}

/**
 * pushNotification
 * 参数：sessionId 会话 ID；text 尾部回复；status 结束状态
 * 核心流程：解析标签拿标题 → 组装通知（同会话覆盖、新条目置顶、超出上限丢最旧）
 *           → 若正在看该会话则响铃；气泡统一 10 秒后自动消失
 */
function pushNotification(sessionId: string, text: string | undefined, status: NotificationStatus) {
  if (!notifyEnabled()) return
  const tab = findTab(sessionId)
  if (!tab) return
  const entry: SessionNotification = {
    sessionId,
    title: tab.title || "Untitled",
    detail: summarize(text, status),
    status,
    createdAt: Date.now(),
  }
  clearTimer(sessionId)
  setNotifications((prev) => [entry, ...prev.filter((item) => item.sessionId !== sessionId)].slice(0, MAX_NOTIFICATIONS))
  const viewing = viewingSessionId() === sessionId
  // 不在这个会话里跑完的，标签上留一个圆点：气泡 10 秒后消失，圆点要一直在
  markUnread(sessionId, !viewing)
  if (viewing) playNotificationSound()
  startDismissTimer(sessionId)
}

// 订阅全局 SSE：run_complete 说明某会话本回合已结束
subscribeEvents((ev) => {
  if (ev.type !== "run_complete") return
  const payload = ev.payload as
    | { session_id?: string; text?: string; error?: string; cancelled?: boolean }
    | null
  if (!payload?.session_id) return
  // 自己取消的不打扰：取消是用户主动行为，弹泡只会增加噪音
  if (payload.cancelled === true) return
  pushNotification(payload.session_id, payload.error || payload.text, payload.error ? "error" : "done")
})

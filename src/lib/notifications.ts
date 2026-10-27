/**
 * notifications.ts
 * 核心流程：全局「会话跑完了」通知表 ——
 *           SSE 收到 run_complete 且该会话已有标签时入队（同一会话覆盖去重）；
 *           正在看这个会话 → 播放提示音并 10 秒后自动消失；
 *           不在这个会话 → 一直挂着，直到用户切到该会话才开始 10 秒倒计时
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

/** 气泡在「当前会话」停留时长 */
export const NOTIFICATION_TTL_MS = 10_000
/** 通知表最多保留条数，超出丢弃最旧的 */
const MAX_NOTIFICATIONS = 5
/** 摘要正文最大字符数 */
const MAX_DETAIL_CHARS = 120

const [notifications, setNotifications] = createSignal<SessionNotification[]>([])
const [viewingSessionId, setViewingSessionIdRaw] = createSignal<string | undefined>(undefined)

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
 * dismissNotification
 * 参数：sessionId 会话 ID
 * 核心流程：移除通知并清掉计时器；手动关闭与倒计时到期都走这里
 */
export function dismissNotification(sessionId: string) {
  clearTimer(sessionId)
  setNotifications((prev) => (prev.some((item) => item.sessionId === sessionId) ? prev.filter((item) => item.sessionId !== sessionId) : prev))
}

/**
 * startTimerIfViewing
 * 参数：sessionId 会话 ID
 * 核心流程：只为「正在看的会话」起 10 秒倒计时；其他会话保持常驻，等切过去再起
 */
function startTimerIfViewing(sessionId: string) {
  if (viewingSessionId() !== sessionId) {
    clearTimer(sessionId)
    return
  }
  if (timers.has(sessionId)) return
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      dismissNotification(sessionId)
    }, NOTIFICATION_TTL_MS),
  )
}

/**
 * setViewingSession
 * 参数：sessionId 当前打开的会话（不在会话页时为 undefined）
 * 核心流程：切换当前会话 → 进入的会话开始 10 秒倒计时、离开的会话暂停计时保持常驻
 */
export function setViewingSession(sessionId: string | undefined) {
  if (viewingSessionId() === sessionId) return
  setViewingSessionIdRaw(sessionId)
  for (const item of notifications()) startTimerIfViewing(item.sessionId)
}

/**
 * pushNotification
 * 参数：sessionId 会话 ID；text 尾部回复；status 结束状态
 * 核心流程：解析标签拿标题 → 组装通知（同会话覆盖、新条目置顶、超出上限丢最旧）
 *           → 若正在看该会话则响铃并起倒计时
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
  if (viewingSessionId() === sessionId) playNotificationSound()
  startTimerIfViewing(sessionId)
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

/**
 * run-status.ts
 * 核心流程：全局「哪个会话正在跑」状态表 ——
 *           SSE 收到某会话的 message 事件即标记运行、run_complete 清空；
 *           会话页把本地 busy 同步进来，保证点击发送后标签立刻出现运行图标，
 *           不必等第一条 SSE 事件到达
 */
import { createSignal } from "solid-js"
import { subscribeEvents } from "./events"

const [runningSessions, setRunningSessions] = createSignal<ReadonlySet<string>>(new Set())

/**
 * isSessionRunning
 * 参数：sessionId 会话 ID
 * 核心流程：查运行集合，供标签栏渲染运行图标
 */
export function isSessionRunning(sessionId: string): boolean {
  return runningSessions().has(sessionId)
}

/**
 * markRunning / markIdle
 * 参数：sessionId 会话 ID
 * 核心流程：幂等增删运行集合；集合未变化时不触发信号更新，避免多余重渲染
 */
function setRunning(sessionId: string, running: boolean) {
  if (!sessionId) return
  setRunningSessions((prev) => {
    if (prev.has(sessionId) === running) return prev
    const next = new Set(prev)
    if (running) next.add(sessionId)
    else next.delete(sessionId)
    return next
  })
}

/**
 * setSessionRunning
 * 参数：sessionId 会话 ID；running 是否运行中
 * 核心流程：对外入口，会话页用它把本地 busy 同步到全局表
 */
export function setSessionRunning(sessionId: string, running: boolean) {
  setRunning(sessionId, running)
}

// 订阅全局 SSE：message 说明该会话正在产消息；run_complete 说明本回合结束
subscribeEvents((ev) => {
  if (ev.type === "run_complete") {
    const payload = ev.payload as { session_id?: string } | null
    if (payload?.session_id) setRunning(payload.session_id, false)
    return
  }
  if (ev.type === "session") {
    // SSE 的 session 载荷不填 is_busy，只在明确为 true 时采纳
    const payload = ev.payload as { id?: string; is_busy?: boolean } | null
    if (payload?.id && payload.is_busy === true) setRunning(payload.id, true)
    return
  }
  if (ev.type === "message") {
    const payload = ev.payload as
      | { session_id?: string; parts?: Array<{ type?: string }> }
      | null
    if (!payload?.session_id) return
    // 带 finish 分片的消息是本回合的收尾：它可能在 run_complete 之后到达，
    // 若无条件标记运行，取消/结束后标签会一直转圈
    const finished = Array.isArray(payload.parts) && payload.parts.some((part) => part?.type === "finish")
    if (!finished) setRunning(payload.session_id, true)
  }
})

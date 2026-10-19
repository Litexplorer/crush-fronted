/**
 * events.ts
 * 核心流程：workspace SSE 单一 EventSource 封装 ——
 *           服务端 data: 行为双层信封 {type, payload:{type,payload}}（pubsub.Payload 外层、
 *           pubsub.Event 内层，见 internal/server/events.go wrapEvent），解包归一为
 *           {type, eventType, payload} 后广播给订阅者；断开时关闭原生自动重连，
 *           3 秒后自动重连一次，再失败保持 disconnected 由下次 ensureEvents 重建
 */
import { createSignal, type Accessor } from "solid-js"
import { getClientId } from "./clientId"

/** 连接状态：connecting 建连中 / connected 已建立 / disconnected 已断开 */
export type ConnectionState = "connecting" | "connected" | "disconnected"

/** 解包后的 workspace 事件：type 为外层载荷类型（message/session/run_complete…） */
export interface WorkspaceEvent {
  type: string
  eventType: string
  payload: unknown
}

let es: EventSource | null = null
let currentWsId: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectUsed = false

const listeners = new Set<(ev: WorkspaceEvent) => void>()
/** 连接打开回调：每次 SSE 变为 connected（首次建连/重连成功）时触发 */
const openListeners = new Set<() => void>()
const [connection, setConnection] = createSignal<ConnectionState>("disconnected")

/**
 * open
 * 参数：wsId workspace ID
 * 核心流程：建立 EventSource（client_id 必填，requireClientID 校验 UUID）
 *           → onopen 置 connected → onmessage 解双层信封并广播 → onerror 关闭后 3 秒重连一次
 */
function open(wsId: string) {
  setConnection("connecting")
  const url = `/v1/workspaces/${encodeURIComponent(wsId)}/events?client_id=${encodeURIComponent(getClientId())}`
  const source = new EventSource(url)
  es = source

  // 连接建立：后端 handleGetWorkspaceEvents 立即 WriteHeader+Flush，onopen 会及时触发
  source.onopen = () => {
    setConnection("connected")
    // 连接打开（含重连成功）：通知订阅者，驱动 current-session 等依赖长连接的上报
    for (const fn of openListeners) fn()
  }

  source.onmessage = (e: MessageEvent<string>) => {
    let outer: { type?: string; payload?: unknown }
    try {
      outer = JSON.parse(e.data) as { type?: string; payload?: unknown }
    } catch {
      // 非 JSON 的 data 行：跳过，不中断连接
      return
    }
    // 双层信封解包：外层 type 是载荷类别，内层 type 是 created/updated/deleted
    const inner = outer.payload as { type?: string; payload?: unknown } | undefined
    const eventType = inner && typeof inner.type === "string" ? inner.type : ""
    const payload = inner && inner.payload !== undefined ? inner.payload : inner
    const event: WorkspaceEvent = { type: outer.type ?? "", eventType, payload }
    for (const fn of listeners) fn(event)
  }

  source.onerror = () => {
    // 关闭原生自动重连，改为自行控制：3 秒后重连一次
    source.close()
    if (es === source) es = null
    setConnection("disconnected")
    if (reconnectUsed) return
    reconnectUsed = true
    reconnectTimer = setTimeout(() => {
      if (currentWsId === wsId) open(wsId)
    }, 3000)
  }
}

/**
 * ensureEvents
 * 参数：wsId workspace ID
 * 核心流程：同一 workspace 已有连接则复用；否则关闭旧连接并新建（全局同时只有一个 EventSource）
 */
export function ensureEvents(wsId: string): void {
  if (es && currentWsId === wsId) return
  closeEvents()
  currentWsId = wsId
  reconnectUsed = false
  open(wsId)
}

/**
 * closeEvents
 * 参数：无
 * 核心流程：取消重连计时器、关闭 EventSource、状态复位为 disconnected（页面卸载时调用）
 */
export function closeEvents(): void {
  clearTimeout(reconnectTimer)
  reconnectUsed = false
  currentWsId = null
  if (es) {
    es.close()
    es = null
  }
  setConnection("disconnected")
}

/**
 * subscribeEvents
 * 参数：fn 事件回调
 * 核心流程：注册监听器，返回取消订阅函数（组件 onCleanup 时调用）
 */
export function subscribeEvents(fn: (ev: WorkspaceEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * onEventsOpen
 * 参数：fn 连接建立回调
 * 核心流程：注册回调，每次 SSE 变为 connected（首次建连/重连成功）时触发；
 *           注册时若已处于 connected 则立即触发一次（会话切换时无需等重连）；
 *           返回取消订阅函数（组件 onCleanup 时调用）
 */
export function onEventsOpen(fn: () => void): () => void {
  openListeners.add(fn)
  // 已连接：注册即触发，保证切换会话时立即上报 current-session
  if (connection() === "connected") fn()
  return () => {
    openListeners.delete(fn)
  }
}

/** 当前连接状态（只读 signal），会话页头部圆点据此变色 */
export const eventsConnection: Accessor<ConnectionState> = connection

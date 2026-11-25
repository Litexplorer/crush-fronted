/**
 * mascot-report.ts
 * 核心流程：鲸鱼娘定时巡检 ——
 *           每 10 分钟读一次系统指标（CPU/内存/根盘）与当前会话用量（上下文占比、cache 命中率），
 *           拼成一句话交给 lib/notifications 的气泡通道播报；
 *           页面隐藏、或已有通知待播时跳过本轮，避免打扰与插队
 */
import { notifications, sayTip } from "./notifications"
import { getSystemMetrics } from "./system-metrics"
import { getSession } from "./sessions"
import { formatTokens } from "./usage"
import { contextWindow } from "./mascot-stats"

/** 巡检间隔：10 分钟一次 */
export const MASCOT_REPORT_INTERVAL_MS = 10 * 60 * 1000

let timer: ReturnType<typeof setInterval> | undefined

/**
 * parseSessionPath
 * 参数：pathname 当前路由路径
 * 核心流程：从 /w/<ws>/session/<sid> 抽出工作区与会话 ID，非会话页返回 undefined
 */
function parseSessionPath(pathname: string): { wsId: string; sid: string } | undefined {
  const match = /^\/w\/([^/]+)\/session\/([^/?#]+)/.exec(pathname)
  return match ? { wsId: decodeURIComponent(match[1]), sid: decodeURIComponent(match[2]) } : undefined
}

/**
 * buildSystemLine
 * 参数：无
 * 核心流程：GET /system/metrics → 取 CPU 占比、内存占比与根分区占比；失败返回 undefined
 */
async function buildSystemLine(): Promise<string | undefined> {
  try {
    const metrics = await getSystemMetrics()
    const root = metrics.disks.find((disk) => disk.mount === "/") ?? metrics.disks[0]
    const parts = [
      `CPU ${Math.round(metrics.cpu.percent)}%`,
      `内存 ${Math.round(metrics.memory.percent)}%`,
    ]
    if (root) parts.push(`根盘 ${Math.round(root.percent)}%`)
    return parts.join(" · ")
  } catch {
    return undefined
  }
}

/**
 * buildSessionLine
 * 参数：无
 * 核心流程：按当前路由取会话 → 上下文占比优先用模型窗口算，窗口未知则显示绝对用量
 *           → cache 命中率按 hit/(hit+miss)；不在会话页或请求失败返回 undefined
 */
async function buildSessionLine(): Promise<string | undefined> {
  const target = parseSessionPath(window.location.pathname)
  if (!target) return undefined
  try {
    const session = await getSession(target.wsId, target.sid)
    const used = (session.prompt_tokens ?? 0) + (session.completion_tokens ?? 0)
    const limit = contextWindow()
    const parts = [limit ? `上下文 ${Math.round((used / limit) * 100)}%` : `上下文 ${formatTokens(used)}`]
    const hit = session.cache_read_tokens ?? 0
    const miss = session.uncached_input_tokens ?? 0
    if (hit + miss > 0) parts.push(`cache ${((hit / (hit + miss)) * 100).toFixed(2)}%`)
    return parts.join(" · ")
  } catch {
    return undefined
  }
}

/**
 * reportOnce
 * 参数：无
 * 核心流程：页面隐藏或队列非空时跳过 → 并发取两段数据 → 拼成一条 tip 播报
 *           结果：右下角小鲸说一句「CPU … ｜ 上下文 …」
 */
export async function reportOnce() {
  if (typeof document !== "undefined" && document.hidden) return
  // 有真实通知在排队时先让别人说完，巡检下一轮再来
  if (notifications().length > 0) return
  const [system, session] = await Promise.all([buildSystemLine(), buildSessionLine()])
  const line = [system, session].filter(Boolean).join(" ｜ ")
  if (line) sayTip(line)
}

/**
 * startMascotReports
 * 参数：intervalMs 巡检间隔，默认 10 分钟
 * 核心流程：只挂一个定时器（重复调用无副作用）→ 每轮异步执行 reportOnce
 */
export function startMascotReports(intervalMs = MASCOT_REPORT_INTERVAL_MS) {
  if (timer !== undefined) return
  timer = setInterval(() => void reportOnce(), intervalMs)
}

/**
 * stopMascotReports
 * 参数：无
 * 核心流程：清掉巡检定时器，页面根组件卸载时调用
 */
export function stopMascotReports() {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/**
 * server-status.ts
 * 核心流程：全局唯一的「服务端状态」轮询器 ——
 *           每 5s 探测一次 /v1/health，连续失败达到阈值才判定断连（避免重启瞬间闪红）；
 *           连上时顺带 GET /v1/version 读取 build_id，
 *           首次读到作为基线，之后变化即说明服务端换过二进制（重启/重建）；
 *           状态供顶栏圆点与顶部提示条共用，避免两处各自轮询。
 */
import { createSignal } from "solid-js"
import { getVersion } from "./version"

/** 连接状态：connecting 首次探测未回；connected 健康；disconnected 连续失败 */
export type ServerConnection = "connecting" | "connected" | "disconnected"

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 5000
/** 连续多少次失败才判定断连：单次抖动不该闪红 */
const DOWN_AFTER_FAILURES = 2
/** 单次探测超时：服务端卡住时不该拖住下一轮 */
const PROBE_TIMEOUT = 2000
/** 用户手动关闭提示后按 build_id 记住，同一次重启只提示一次 */
const DISMISS_KEY = "crush.dismissedBuildId"

const [serverConnection, setConnection] = createSignal<ServerConnection>("connecting")
const [serverBuildId, setBuildId] = createSignal("")
const [serverVersion, setServerVersion] = createSignal("")
const [dismissedBuildId, setDismissedBuildId] = createSignal(
  typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem(DISMISS_KEY) ?? "",
)

/** 页面加载后第一次看到的 build_id：服务端换二进制后与它不一致 */
let baselineBuildId = ""
let failures = 0
let timer: ReturnType<typeof setInterval> | undefined

export { serverConnection, serverBuildId, serverVersion }

/**
 * serverDown
 * 参数：无
 * 核心流程：判定「服务端不可用」—— 提示条据此显示重启命令
 */
export function serverDown(): boolean {
  return serverConnection() === "disconnected"
}

/**
 * serverRestarted
 * 参数：无
 * 核心流程：判定「服务端换过二进制」—— 有基线、当前 build_id 与基线不同、且未被手动关闭
 */
export function serverRestarted(): boolean {
  const current = serverBuildId()
  if (!current || !baselineBuildId || current === baselineBuildId) return false
  return current !== dismissedBuildId()
}

/**
 * probeOnce
 * 参数：无
 * 核心流程：GET /v1/health（带超时）→ 更新连接状态 →
 *           连上时同步版本，记录基线/发现变化
 */
async function probeOnce() {
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
  let ok = false
  try {
    const res = await fetch("/v1/health", { method: "GET", signal: controller.signal })
    ok = res.ok
  } catch {
    ok = false
  }
  clearTimeout(abort)

  if (!ok) {
    failures += 1
    if (failures >= DOWN_AFTER_FAILURES) setConnection("disconnected")
    return
  }

  failures = 0
  setConnection("connected")
  await refreshVersion()
}

/**
 * refreshVersion
 * 参数：无
 * 核心流程：读取 /v1/version → 更新 build_id/version 信号；
 *           build_id 首次读到即为基线，之后与基线比较判断是否换过二进制
 */
async function refreshVersion() {
  try {
    const info = await getVersion()
    const current = info.build_id ?? ""
    if (!current || current === serverBuildId()) {
      if (info.version) setServerVersion(info.version)
      return
    }
    setBuildId(current)
    setServerVersion(info.version)
    if (!baselineBuildId) baselineBuildId = current
  } catch {
    // 版本探测失败不影响连接状态：health 已经回过 2xx
  }
}

/**
 * probeServerNow
 * 参数：无
 * 核心流程：立刻探测一次，供「重试」按钮和页面重新可见时使用
 */
export function probeServerNow() {
  void probeOnce()
}

/**
 * startServerStatusPolling
 * 参数：无
 * 核心流程：幂等启动轮询（首次立即探测 + 定时器），重复调用不会叠加定时器
 */
export function startServerStatusPolling() {
  if (timer !== undefined) return
  void probeOnce()
  timer = setInterval(() => void probeOnce(), POLL_INTERVAL)
}

/**
 * stopServerStatusPolling
 * 参数：无
 * 核心流程：停止轮询并复位，供热更新/测试清理
 */
export function stopServerStatusPolling() {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

/**
 * dismissServerRestart
 * 参数：无
 * 核心流程：按当前 build_id 记住「这条提示别再弹」，写入 sessionStorage
 */
export function dismissServerRestart() {
  const current = serverBuildId()
  if (!current) return
  setDismissedBuildId(current)
  try {
    sessionStorage.setItem(DISMISS_KEY, current)
  } catch {
    // 隐私模式下 sessionStorage 不可用：仅本次会话内生效
  }
}

/**
 * reloadPage
 * 参数：无
 * 核心流程：整页刷新，让浏览器重新拉取与新版服务端匹配的前端资源
 */
export function reloadPage() {
  location.reload()
}

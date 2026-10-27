/**
 * notification-sound.ts
 * 核心流程：会话完成的提示音 ——
 *           用 WebAudio 合成两声短音（880Hz → 1175Hz），不引入音频资源；
 *           浏览器要求用户手势后才允许发声，因此模块加载时挂一次性
 *           pointerdown / keydown 解锁，遇到 AudioContext 挂起则尝试 resume
 */

const [FIRST_TONE_HZ, SECOND_TONE_HZ] = [880, 1174.66]

let context: AudioContext | undefined
let unarmed = true

/**
 * ensureContext
 * 参数：无
 * 核心流程：惰性创建 AudioContext；已挂起时尝试 resume，
 *           某些浏览器 resume 返回被拒绝的 Promise，失败沉默不抛
 */
function ensureContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined
  const Ctor = window.AudioContext
  if (!Ctor) return undefined
  context ??= new Ctor()
  if (context.state === "suspended") void context.resume().catch(() => undefined)
  return context
}

/**
 * chime
 * 参数：ctx 音频上下文；startAt 起始时间；hz 频率；duration 单音时长
 * 核心流程：正弦波 + 指数衰减包络，避免爆音；起止两端的 gain 都是渐变
 */
function chime(ctx: AudioContext, startAt: number, hz: number, duration: number) {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = "sine"
  oscillator.frequency.value = hz
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  oscillator.connect(gain).connect(ctx.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + duration + 0.02)
}

/**
 * playNotificationSound
 * 参数：无
 * 核心流程：两声上行短音；上下文不可用或仍被浏览器拦截时静默失败，
 *           提示音永远不影响通知本身的展示
 */
export function playNotificationSound() {
  try {
    const ctx = ensureContext()
    if (!ctx || ctx.state !== "running") return
    const now = ctx.currentTime + 0.02
    chime(ctx, now, FIRST_TONE_HZ, 0.12)
    chime(ctx, now + 0.14, SECOND_TONE_HZ, 0.16)
  } catch {
    // 音频不可用：忽略
  }
}

/**
 * arm
 * 参数：无
 * 核心流程：首次用户手势时创建/唤醒 AudioContext（手势之后浏览器才允许发声），
 *           解锁后移除监听，后续完成事件才能立即响
 */
function arm() {
  if (!unarmed) return
  unarmed = false
  ensureContext()
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", arm, { once: true, passive: true })
  window.addEventListener("keydown", arm, { once: true })
}

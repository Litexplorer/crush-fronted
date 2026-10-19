/**
 * usage-meter.tsx
 * 参数：session 当前会话；messages 时间线；busy 是否生成中；
 *       contextWindow 当前模型上下文窗口（由 ModelSelect 上报）
 * 核心流程：Composer 底部的用量指示器 ——
 *           上下文占比 =（prompt_tokens + completion_tokens）/ context_window
 *           生成中按 SSE 文本增量估算实时吐字速率（1s 窗口 + EWMA 平滑）
 *           空闲时回退到 finish 分片持久化的 output_tokens/generation_ms
 */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { Session } from "../lib/sessions"
import type { FinishPartData, TimelineMessage } from "./message/parts"
import { approxTokens, formatTokens, tokenRate } from "../lib/usage"

/** 与 internal/ui/common/rate.go 保持一致的采样参数 */
const RATE_WINDOW = 1000
const RATE_HISTORY = 2000
const RATE_MIN_SPAN = 500
const RATE_EWMA_ALPHA = 0.3

const RING_RADIUS = 6
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

interface RateSample {
  at: number
  tokens: number
}

/**
 * latestAssistant
 * 参数：messages 时间线
 * 核心流程：从后往前找最后一条非摘要 assistant 消息
 */
function latestAssistant(messages: TimelineMessage[]): TimelineMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant" || message.is_summary_message) continue
    return message
  }
  return undefined
}

/**
 * hasFinish
 * 参数：message assistant 消息
 * 核心流程：分片里出现 finish 即视为本步生成结束
 */
function hasFinish(message: TimelineMessage): boolean {
  return message.parts.some((part) => part.type === "finish")
}

export default function UsageMeter(props: {
  session?: Session
  messages: TimelineMessage[]
  busy: boolean
  contextWindow?: number
}) {
  const [liveRate, setLiveRate] = createSignal<number>()

  let samples: RateSample[] = []
  let smoothed = 0
  let hasValue = false
  let timer: number | undefined

  /**
   * resetRate
   * 参数：无
   * 核心流程：丢弃上一回合的采样窗口与平滑值
   */
  function resetRate() {
    samples = []
    smoothed = 0
    hasValue = false
  }

  /**
   * observeTokens
   * 参数：tokens 当前流式文本的累计估算 token
   * 核心流程：累计值回退时重置窗口；追加样本并裁剪 2s 历史；
   *           历史跨度不足 500ms 不产出速率，避免开局突发被放大
   */
  function observeTokens(tokens: number) {
    const now = performance.now()
    const previous = samples.length > 0 ? samples[samples.length - 1].tokens : 0
    if (tokens < previous) {
      samples = []
      smoothed = 0
      hasValue = false
    }
    samples.push({ at: now, tokens })

    const cut = now - RATE_HISTORY
    let drop = 0
    while (drop < samples.length - 1 && samples[drop].at < cut) drop++
    if (drop > 0) samples = samples.slice(drop)

    if (samples.length < 2) return
    if (now - samples[0].at < RATE_MIN_SPAN) return

    const rate = rateFromSamples(samples, now)
    if (hasValue) {
      smoothed = RATE_EWMA_ALPHA * rate + (1 - RATE_EWMA_ALPHA) * smoothed
    } else {
      smoothed = rate
      hasValue = true
    }
  }

  /**
   * rateFromSamples
   * 参数：samples 升序采样点；now 当前时刻
   * 核心流程：锚点取窗口起点前最近的样本；超过 1s 无新增返回 0；
   *           否则返回（末累计 - 锚累计）/ 时间跨度
   */
  function rateFromSamples(list: RateSample[], now: number): number {
    if (list.length < 2) return 0
    const last = list[list.length - 1]
    if (now - last.at >= RATE_WINDOW) return 0

    let anchor = list[0]
    const cut = now - RATE_WINDOW
    for (const sample of list) {
      if (sample.at > cut) break
      anchor = sample
    }
    const span = last.at - anchor.at
    if (span <= 0) return 0
    return (last.tokens - anchor.tokens) / (span / 1000)
  }

  /**
   * currentRate
   * 参数：now 当前时刻
   * 核心流程：尚无有效窗口返回 undefined；超过 1s 未吐字返回 0；否则返回平滑速率
   */
  function currentRate(now: number): number | undefined {
    if (!hasValue || samples.length === 0) return undefined
    if (now - samples[samples.length - 1].at >= RATE_WINDOW) return 0
    return smoothed
  }

  /**
   * streamingMessage
   * 核心流程：最后一条 assistant 尚未 finish 时返回它，否则视为没有流式消息
   */
  const streamingMessage = createMemo<TimelineMessage | undefined>(() => {
    const message = latestAssistant(props.messages)
    if (!message || hasFinish(message)) return undefined
    return message
  })

  /**
   * liveTokens
   * 核心流程：拼接流式消息的正文与思考分片，按后端同口径估算 token
   */
  const liveTokens = createMemo(() => {
    const message = streamingMessage()
    if (!message) return 0
    let text = ""
    let thinking = ""
    for (const part of message.parts) {
      if (part.type === "text") {
        const data = (part.data ?? {}) as { text?: string; hidden?: boolean }
        if (data.hidden !== true && typeof data.text === "string") text += data.text
      } else if (part.type === "reasoning") {
        const data = (part.data ?? {}) as { thinking?: string }
        if (typeof data.thinking === "string") thinking += data.thinking
      }
    }
    return approxTokens(text) + approxTokens(thinking)
  })

  /**
   * finalRate
   * 核心流程：取最后一条 assistant 的 finish 记账计算最终速率；本报文无记账则不展示
   */
  const finalRate = createMemo<number | undefined>(() => {
    const message = latestAssistant(props.messages)
    if (!message) return undefined
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]
      if (part.type !== "finish") continue
      const data = (part.data ?? {}) as FinishPartData
      return tokenRate(data.output_tokens, data.generation_ms)
    }
    return undefined
  })

  // 流式文本变化：追加采样并立即刷新一次速率
  createEffect(() => {
    const message = streamingMessage()
    const tokens = liveTokens()
    if (!props.busy || !message) {
      resetRate()
      setLiveRate(undefined)
      return
    }
    observeTokens(tokens)
    setLiveRate(currentRate(performance.now()))
  })

  // 文本停止更新后仍需把速率降回 0，250ms 轮询平滑值
  onMount(() => {
    timer = window.setInterval(() => {
      if (!props.busy || !streamingMessage()) return
      setLiveRate(currentRate(performance.now()))
    }, 250)
  })

  onCleanup(() => {
    if (timer !== undefined) window.clearInterval(timer)
  })

  /**
   * rateLabel
   * 核心流程：流式阶段展示带 "~" 的估算速率；其余阶段展示服务端持久化速率
   */
  const rateLabel = createMemo(() => {
    const rate = streamingMessage() ? liveRate() : finalRate()
    if (rate === undefined) return ""
    const prefix = streamingMessage() ? "~" : ""
    return `${prefix}${Math.round(rate)} tok/s`
  })

  const rateTitle = createMemo(() =>
    streamingMessage() ? "Estimated output rate (live)" : "Average output rate for the last turn",
  )

  const contextTokens = createMemo(() => {
    const session = props.session
    if (!session) return 0
    return (session.prompt_tokens ?? 0) + (session.completion_tokens ?? 0)
  })

  const percent = createMemo<number | undefined>(() => {
    const limit = props.contextWindow
    if (!limit || limit <= 0) return undefined
    return Math.round((contextTokens() / limit) * 100)
  })

  const contextTitle = createMemo(() => {
    const limit = props.contextWindow
    if (!limit) return ""
    return `Context: ${formatTokens(contextTokens())} / ${formatTokens(limit)} tokens`
  })

  const ringDash = createMemo(() => {
    const filled = (RING_CIRCUMFERENCE * Math.min(percent() ?? 0, 100)) / 100
    return `${filled} ${RING_CIRCUMFERENCE}`
  })

  return (
    <div class="flex shrink-0 items-center gap-2 text-[11px] leading-none tabular-nums text-faint">
      <Show when={rateLabel()}>
        <span class="whitespace-nowrap text-muted" title={rateTitle()}>
          {rateLabel()}
        </span>
      </Show>
      <Show when={percent() !== undefined}>
        <span
          class="flex items-center gap-1 whitespace-nowrap"
          classList={{
            "text-[#f5a623]": (percent() ?? 0) >= 75 && (percent() ?? 0) < 90,
            "text-[#e5484d]": (percent() ?? 0) >= 90,
          }}
          title={contextTitle()}
          aria-label={`Context usage ${percent()}%`}
        >
          <svg viewBox="0 0 16 16" class="size-3.5 -rotate-90" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r={RING_RADIUS} stroke-width="2" stroke-opacity="0.2" />
            <Show when={(percent() ?? 0) > 0}>
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                stroke-width="2"
                stroke-linecap="round"
                stroke-dasharray={ringDash()}
              />
            </Show>
          </svg>
          {percent()}%
        </span>
      </Show>
    </div>
  )
}

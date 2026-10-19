/**
 * subagent-card.tsx
 * 参数：messageId 父 assistant 消息；toolCall agent 工具调用；result 对应工具结果；
 *       finished 工具是否完成；open / onToggle 可选受控展开
 * 核心流程：子 agent 专用卡片 ——
 *           header    任务标题、运行状态、耗时与当前步骤
 *           task      原始任务 prompt（Markdown、限高）
 *           activity  子会话内的工具调用树，支持继续嵌套 agent
 *           result    子 agent 最终答复（Markdown）
 *           footer    模型与 token 用量
 *           展开时按 child session id 懒加载子会话历史
 */
import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import type { SessionMessage } from "../../lib/sessions"
import { formatTokens } from "../../lib/usage"
import {
  childSessionId,
  parseSubagentMeta,
  parseSubagentPrompt,
  subagentTitle,
  type SubagentMeta,
} from "../../lib/subagents"
import { MarkdownText } from "./markdown"
import { useSubagentStore } from "./subagent-context"
import { formatJson, toolIcon, toolSummary } from "./tool-visuals"
import type { ToolCallPartData, ToolResultPartData } from "./parts"

interface SubagentCardProps {
  messageId: string
  toolCall: ToolCallPartData
  result?: ToolResultPartData
  finished: boolean
  open?: boolean
  onToggle?: () => void
}

interface ActivityItem {
  messageId: string
  call: ToolCallPartData
}

/**
 * formatDuration
 * 参数：ms 毫秒
 * 核心流程：小于 1 秒显示 ms，小于 60 秒显示一位小数秒，其余显示分秒
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}m ${rest}s`
}

/**
 * formatStartedAt
 * 参数：seconds Unix 秒
 * 核心流程：子会话可能没有精确耗时，用创建到更新的秒差兜底
 */
function sessionDurationMs(messagesSession: { created_at?: number; updated_at?: number } | undefined): number | undefined {
  if (!messagesSession) return undefined
  const created = messagesSession.created_at ?? 0
  const updated = messagesSession.updated_at ?? 0
  if (created <= 0 || updated <= created) return undefined
  return (updated - created) * 1000
}

/**
 * lastAssistantModel
 * 参数：messages 子会话消息
 * 核心流程：从后往前找最后一条非摘要 assistant 的 model
 */
function lastAssistantModel(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant" || message.is_summary_message) continue
    if (message.model) return message.model
  }
  return ""
}

export default function SubagentCard(props: SubagentCardProps) {
  const store = useSubagentStore()
  const [localOpen, setLocalOpen] = createSignal(false)

  const isOpen = () => props.open ?? localOpen()
  const prompt = createMemo(() => parseSubagentPrompt(props.toolCall.input))
  const meta = createMemo<SubagentMeta>(() => parseSubagentMeta(props.result?.metadata))

  /**
   * id
   * 核心流程：优先使用后端 metadata 的 session_id；旧数据回退到 messageID$$toolCallID
   */
  const id = createMemo(() => {
    const fromMeta = meta().session_id
    if (fromMeta) return fromMeta
    const callId = props.toolCall.id
    return callId ? childSessionId(props.messageId, callId) : ""
  })

  const childSession = () => (id() ? store?.sessions()[id()] : undefined)
  const childMessages = () => (id() ? store?.messages()[id()] ?? [] : [])
  const loading = () => (id() ? store?.loading()[id()] === true : false)
  const loadError = () => (id() ? store?.errors()[id()] ?? "" : "")

  const running = () => props.finished !== true && !props.result
  const failed = () => props.result?.is_error === true

  const title = createMemo(() => {
    const metaTitle = meta().title
    if (metaTitle && metaTitle !== "New Agent Session") return metaTitle
    const sessionTitle = childSession()?.title
    if (sessionTitle && sessionTitle !== "New Agent Session") return sessionTitle
    return subagentTitle(prompt())
  })

  const resultContent = () => props.result?.content ?? ""

  const results = createMemo(() => {
    const map = new Map<string, ToolResultPartData>()
    for (const message of childMessages()) {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue
        const data = (part.data ?? {}) as ToolResultPartData
        if (data.tool_call_id) map.set(data.tool_call_id, data)
      }
    }
    return map
  })

  const activities = createMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    for (const message of childMessages()) {
      if (message.is_summary_message) continue
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue
        const call = (part.data ?? {}) as ToolCallPartData
        if (!call.name || call.name === "todos") continue
        items.push({ messageId: message.id, call })
      }
    }
    return items
  })

  const currentStep = createMemo(() => {
    const items = activities()
    const last = items[items.length - 1]
    if (!last) return running() ? "thinking…" : ""
    return `${last.call.name ?? "tool"} · ${toolSummary(last.call.name ?? "tool", last.call.input)}`
  })

  const duration = createMemo(() => {
    const metaDuration = meta().duration_ms
    if (metaDuration && metaDuration > 0) return metaDuration
    return sessionDurationMs(childSession())
  })

  const durationLabel = createMemo(() => {
    const value = duration()
    return value && value > 0 ? formatDuration(value) : ""
  })

  const modelLabel = createMemo(() => meta().model || lastAssistantModel(childMessages()))

  const usageLabel = createMemo(() => {
    const session = childSession()
    if (!session) return ""
    const input = session.prompt_tokens ?? 0
    const output = session.completion_tokens ?? 0
    if (input <= 0 && output <= 0) return ""
    return `${formatTokens(input)} in · ${formatTokens(output)} out`
  })

  // 首次展开：按 child session id 拉取历史；实时运行中则先由 SSE 事件填充
  createEffect(() => {
    if (!isOpen()) return
    const childId = id()
    if (childId) store?.ensure(childId)
  })

  // 非受控卡片（嵌套子 agent）在开始运行时自动展开一次
  let autoOpened = false
  createEffect(() => {
    if (props.open !== undefined || autoOpened) return
    if (!running()) return
    autoOpened = true
    setLocalOpen(true)
  })

  /**
   * toggle
   * 核心流程：受控模式交给父级 overrides；非受控模式翻转本地状态
   */
  function toggle() {
    if (props.open !== undefined) {
      props.onToggle?.()
      return
    }
    setLocalOpen((value) => !value)
  }

  return (
    <div
      class="overflow-hidden rounded-[8px] border bg-base transition-colors"
      classList={{
        "border-[#e5484d]/50": failed(),
        "border-edge hover:border-edge-strong": !failed(),
      }}
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-raised/60"
        classList={{ "text-[#e5484d]": failed(), "text-muted": !failed() }}
        aria-expanded={isOpen()}
        onClick={toggle}
      >
        <span classList={{ "text-[#e5484d]": failed(), "text-accent": !failed() }}>
          {toolIcon("agent")}
        </span>
        <span class="shrink-0 font-medium text-text">Sub-agent</span>
        <span class="min-w-0 flex-1 truncate text-text">{title()}</span>
        <Show when={!isOpen() && currentStep()}>
          <span class="hidden min-w-0 max-w-[42%] truncate font-mono text-[11px] text-faint sm:block">
            {currentStep()}
          </span>
        </Show>
        <Show when={running()}>
          <span class="flex shrink-0 items-center gap-1 text-[11px] text-muted">
            <span class="size-1.5 animate-pulse rounded-full bg-accent" />
            Running
          </span>
        </Show>
        <Show when={!running() && failed()}>
          <span class="shrink-0 text-[11px] text-[#e5484d]">Failed</span>
        </Show>
        <Show when={!running() && !failed()}>
          <span class="shrink-0 text-[11px] text-[var(--status-connected)]">Done</span>
        </Show>
        <Show when={durationLabel()}>
          <span class="shrink-0 text-[11px] text-faint">{durationLabel()}</span>
        </Show>
        <svg
          viewBox="0 0 16 16"
          class="size-3 shrink-0 text-faint transition-transform"
          classList={{ "rotate-90": isOpen() }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <Show when={isOpen()}>
        <div class="border-t border-edge px-3 py-2.5 text-[12px]">
          <Show when={prompt()}>
            <section>
              <div class="mb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">Task</div>
              <ClampedMarkdown text={prompt()} tone="muted" />
            </section>
          </Show>

          <section class="mt-3">
            <div class="mb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">Activity</div>
            <Show when={loadError()}>
              <div class="text-[11px] leading-4 text-[#e5484d]">{loadError()}</div>
            </Show>
            <Show when={loading() && activities().length === 0}>
              <div class="text-[11px] leading-4 text-faint">Loading sub-agent activity…</div>
            </Show>
            <Show when={!loading() && !loadError() && activities().length === 0}>
              <div class="text-[11px] leading-4 text-faint">
                {running() ? "Waiting for sub-agent…" : "No tool activity"}
              </div>
            </Show>
            <Show when={activities().length > 0}>
              <div class="ml-1 flex flex-col gap-1 border-l border-edge pl-2">
                <Index each={activities()}>
                  {(activity) => {
                    const call = () => activity().call
                    return (
                      <Show
                        when={(call().name ?? "") === "agent"}
                        fallback={
                          <SubagentToolRow call={call()} result={call().id ? results().get(call().id ?? "") : undefined} />
                        }
                      >
                        <SubagentCard
                          messageId={activity().messageId}
                          toolCall={call()}
                          result={call().id ? results().get(call().id ?? "") : undefined}
                          finished={call().finished === true}
                        />
                      </Show>
                    )
                  }}
                </Index>
              </div>
            </Show>
          </section>

          <Show when={resultContent()}>
            <section class="mt-3">
              <div class="mb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">Result</div>
              <ClampedMarkdown text={resultContent()} tone={failed() ? "error" : "text"} />
            </section>
          </Show>

          <Show when={modelLabel() || usageLabel()}>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge pt-2 text-[10px] text-faint">
              <Show when={modelLabel()}>
                <span class="min-w-0 truncate">{modelLabel()}</span>
              </Show>
              <Show when={usageLabel()}>
                <span class="tabular-nums">{usageLabel()}</span>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * ClampedMarkdown
 * 参数：text Markdown 文本；lines 默认预览行数；tone 文本色调
 * 核心流程：预览态按行高限高并叠加渐隐遮罩，展开态可滚动查看全文；
 *          用 scrollHeight 实测溢出量，只有确实被裁掉时才给出展开按钮
 */
function ClampedMarkdown(props: { text: string; lines?: number; tone?: "muted" | "text" | "error" }) {
  const [expanded, setExpanded] = createSignal(false)
  const [hiddenLines, setHiddenLines] = createSignal(0)
  let contentEl: HTMLDivElement | undefined

  const limit = () => props.lines ?? 10
  const clamped = () => !expanded()

  const measure = () => {
    const el = contentEl
    if (!el) return
    setHiddenLines(Math.max(0, Math.ceil(el.scrollHeight / 20) - limit()))
  }

  // 文本或展开态变化后重新实测；异步渲染（Mermaid 等）通过 DOM 观察补齐
  createEffect(() => {
    props.text
    expanded()
    const el = contentEl
    if (!el) return
    measure()
    const mutation = new MutationObserver(measure)
    mutation.observe(el, { childList: true, subtree: true, characterData: true })
    const resize = new ResizeObserver(measure)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    onCleanup(() => {
      mutation.disconnect()
      resize.disconnect()
    })
  })

  return (
    <div>
      <div
        ref={contentEl}
        class="relative overflow-hidden text-[12px] leading-5"
        classList={{
          "text-[#e5484d]": props.tone === "error",
          "text-text": props.tone === "text",
          "text-muted": props.tone === "muted",
          "max-h-[200px]": clamped(),
          "max-h-[420px] overflow-y-auto": !clamped(),
        }}
      >
        <MarkdownText text={props.text} />
        <Show when={clamped() && hiddenLines() > 0}>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-base to-transparent" />
        </Show>
      </div>
      <Show when={hiddenLines() > 0 || expanded()}>
        <button
          type="button"
          class="mt-1 text-[11px] text-faint transition-colors hover:text-text"
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded() ? "Show less" : `Show more · +${hiddenLines()} lines`}
        </button>
      </Show>
    </div>
  )
}

/**
 * SubagentToolRow
 * 参数：call 子会话工具调用；result 对应结果
 * 核心流程：紧凑工具行，运行中脉冲、失败标红；展开显示格式化 input 与原始输出
 */
function SubagentToolRow(props: { call: ToolCallPartData; result?: ToolResultPartData }) {
  const [open, setOpen] = createSignal(false)
  const name = () => props.call.name || "tool"
  const failed = () => props.result?.is_error === true
  const running = () => !props.result && props.call.finished !== true
  return (
    <div class="overflow-hidden rounded-[6px] border border-edge/70">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] transition-colors hover:bg-raised/60"
        classList={{ "text-[#e5484d]": failed(), "text-muted": !failed() }}
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span classList={{ "text-[#e5484d]": failed(), "text-faint": !failed() }}>{toolIcon(name())}</span>
        <span class="shrink-0 font-medium">{name()}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-faint">
          {toolSummary(name(), props.call.input)}
        </span>
        <Show when={running()}>
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        </Show>
        <Show when={!running() && failed()}>
          <span class="shrink-0 text-[10px] text-[#e5484d]">error</span>
        </Show>
        <Show when={!running() && !failed() && props.result}>
          <svg
            viewBox="0 0 16 16"
            class="size-3 shrink-0 text-[var(--status-connected)]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <path d="m3.5 8.5 3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </Show>
        <svg
          viewBox="0 0 16 16"
          class="size-3 shrink-0 text-faint transition-transform"
          classList={{ "rotate-90": open() }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="flex flex-col gap-1.5 border-t border-edge px-2 py-1.5">
          <pre class="md-pre">{formatJson(props.call.input)}</pre>
          <Show when={props.result?.content}>
            <pre class="md-pre" classList={{ "text-[#e5484d]": failed() }}>{props.result?.content}</pre>
          </Show>
        </div>
      </Show>
    </div>
  )
}

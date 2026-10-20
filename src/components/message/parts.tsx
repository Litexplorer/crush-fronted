/**
 * parts.tsx
 * 核心流程：消息内容渲染层 ——
 *           MessageItem     消息入口：user 右侧气泡 / assistant 左对齐逐分片渲染
 *           text            user 纯文本保留换行，assistant 走 Markdown
 *           reasoning       Thinking 折叠卡：流式自动展开、结束自动折叠，可点击切换
 *           tool_call       工具卡片：图标+名称+参数摘要，可展开 input JSON；
 *                           按 tool_call_id 合并对应 tool_result 一并展示
 *           tool_result     无对应调用时独立成卡
 *           shell_command   $ command + output 等宽卡片
 *           image_url/binary 图片缩略图（点击放大），非图片 binary 仍显示 [image] 占位
 *           finish          底部一行小字（结果 + 耗时）
 */
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import type { ContentPart, SessionMessage } from "../../lib/sessions"
import { tokenRate } from "../../lib/usage"
import { MarkdownText } from "./markdown"
import SubagentCard from "./subagent-card"
import { ClampedPreview } from "./clamped-preview"
import EditDiff, { parseEditDiff } from "./edit-diff"
import ViewCode, { parseViewData } from "./view-code"
import BashBody, { parseBashData } from "./bash-card"
import { useSubagentStore } from "./subagent-context"
import RunningIndicator from "./running-indicator"
import { formatJson, toolIcon, toolLabel, toolSummary, toolTone } from "./tool-visuals"

/** 时间线消息：proto.Message + 乐观插入 pending 标记 */
export type TimelineMessage = SessionMessage & { pending?: boolean }

/** text 分片：{ text, hidden? } */
export interface TextPartData {
  text?: string
  hidden?: boolean
}

/** reasoning 分片：{ thinking, signature, started_at?, finished_at? } */
export interface ReasoningPartData {
  thinking?: string
  signature?: string
  started_at?: number
  finished_at?: number
}

/** tool_call 分片：{ id, name, input(JSON 字符串), type?, finished? } */
export interface ToolCallPartData {
  id?: string
  name?: string
  input?: string
  type?: string
  finished?: boolean
}

/** tool_result 分片：{ tool_call_id, name, content, metadata(字符串), is_error } */
export interface ToolResultPartData {
  tool_call_id?: string
  name?: string
  content?: string
  data?: string
  mime_type?: string
  metadata?: string
  is_error?: boolean
}

/** finish 分片：{ reason, time, generation_ms? } */
export interface FinishPartData {
  reason?: string
  time?: number
  message?: string
  details?: string
  output_tokens?: number
  generation_ms?: number
}

/** shell_command 分片：{ command, output, exit_code } */
export interface ShellCommandPartData {
  command?: string
  output?: string
  exit_code?: number
}

/** binary 分片：Go 结构体无 json tag，字段名为大写；Data 为 base64 */
export interface BinaryPartData {
  Path?: string
  MIMEType?: string
  Data?: string
}

/** image_url 分片：{ url, detail }，url 可为 http(s) 或 data URL */
export interface ImageUrlPartData {
  url?: string
  detail?: string
}

/**
 * imageSrc
 * 参数：part 内容分片
 * 核心流程：binary 的 base64 拼成 data URL（仅 image/*），image_url 直接取 url；
 *           其余类型或非图片返回 undefined
 */
export function imageSrc(part: ContentPart): string | undefined {
  if (part.type === "binary") {
    const data = (part.data ?? {}) as BinaryPartData
    if (!data.Data || !data.MIMEType?.startsWith("image/")) return undefined
    return `data:${data.MIMEType};base64,${data.Data}`
  }
  if (part.type === "image_url") {
    const data = (part.data ?? {}) as ImageUrlPartData
    return data.url || undefined
  }
  return undefined
}

/**
 * MessageImage
 * 参数：src 图片地址；alt 无障碍文案
 * 核心流程：消息内展示限高缩略图，点击打开全屏遮罩预览，再点任意处关闭
 */
function MessageImage(props: { src: string; alt?: string }) {
  const [open, setOpen] = createSignal(false)

  // 全屏预览打开时监听 Escape：与点击遮罩一样关闭预览
  createEffect(() => {
    if (!open()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <>
      <button
        type="button"
        class="block max-w-full overflow-hidden rounded-lg border border-edge transition-opacity hover:opacity-90"
        onClick={() => setOpen(true)}
      >
        <img
          src={props.src}
          alt={props.alt ?? "attachment"}
          class="max-h-[240px] max-w-full object-contain"
        />
      </button>
      <Show when={open()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setOpen(false)}
        >
          <img
            src={props.src}
            alt={props.alt ?? "attachment"}
            class="max-h-full max-w-full object-contain"
          />
        </div>
      </Show>
    </>
  )
}

/**
 * partText
 * 参数：part 内容分片
 * 核心流程：读取 text 分片纯文本；hidden 分片（上下文注入）与空文本返回空串
 */
export function partText(part: ContentPart): string {
  const data = (part.data ?? {}) as TextPartData
  if (data.hidden === true || typeof data.text !== "string") return ""
  return data.text
}

/**
 * textOf
 * 参数：message 消息
 * 核心流程：拼接全部 text 分片文本（乐观消息与真实消息按此文本匹配替换）
 */
export function textOf(message: TimelineMessage): string {
  return message.parts.filter((p) => p.type === "text").map(partText).join("")
}

/**
 * finishLabel
 * 参数：reason finish 原因枚举值
 * 核心流程：映射为短文案；未知原因原样展示
 */
function finishLabel(reason: string): string {
  const labels: Record<string, string> = {
    end_turn: "Completed",
    max_tokens: "Max tokens",
    tool_use: "Completed",
    canceled: "Canceled",
    error: "Error",
    content_filter: "Filtered",
    unknown: "Completed",
  }
  return labels[reason] ?? reason
}

/**
 * MessageItem
 * 参数：message 单条时间线消息
 * 核心流程：user → 右侧浅色气泡（pending 半透明，纯文本保留换行）；
 *           其余 role → 左对齐无气泡，按 parts 渲染
 */
export function MessageItem(props: { message: TimelineMessage; showFinish?: boolean }) {
  // 空用户消息（中断/仅内部标记）不渲染气泡，避免出现空白圆角块；
  // 仅含图片的消息仍要渲染（历史里的图片附件没有文本）
  if (
    props.message.role === "user" &&
    !textOf(props.message).trim() &&
    !props.message.parts.some((part) => imageSrc(part))
  ) {
    return null
  }
  // 压缩摘要：不按普通 assistant 消息排版，渲染为可折叠的会话压缩卡片
  if (props.message.is_summary_message) return <SummaryMessage message={props.message} />
  return (
    <Show
      when={props.message.role === "user"}
      fallback={<AssistantParts message={props.message} showFinish={props.showFinish} />}
    >
      <div class="flex justify-end">
        <div
          class="flex max-w-[80%] flex-col gap-2 rounded-[12px] bg-raised px-3.5 py-2.5 text-[13px] leading-5 break-words text-text"
          classList={{ "opacity-60": props.message.pending === true }}
        >
          <For each={props.message.parts}>
            {(part) => {
              // 文本分片：保留换行；hidden（上下文注入）不展示
              if (part.type === "text") {
                const text = partText(part)
                return <Show when={text.trim().length > 0}><div class="whitespace-pre-wrap">{text}</div></Show>
              }
              // 图片分片：binary（base64）或 image_url，转成缩略图
              const src = imageSrc(part)
              if (!src) return null
              return <MessageImage src={src} />
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}

/**
 * SummaryMessage
 * 参数：message 压缩摘要消息（is_summary_message）
 * 核心流程：默认折叠为一行状态条，展开后按 Markdown 展示摘要正文；
 *           尚无 finish 分片时显示 Summarizing，提示压缩仍在进行
 */
function SummaryMessage(props: { message: TimelineMessage }) {
  const [open, setOpen] = createSignal(true)
  const streaming = createMemo(() => !props.message.parts.some((p) => p.type === "finish"))
  const texts = createMemo(() =>
    props.message.parts
      .filter((p) => p.type === "text")
      .map(partText)
      .filter((text) => text.trim().length > 0),
  )

  return (
    <div class="overflow-hidden rounded-[10px] border border-edge bg-raised/40">
      <button
        type="button"
        aria-expanded={open()}
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-raised"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 16 16" class="size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M2.5 6.5l4-4M13.5 9.5l-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="font-medium text-text">Context compacted</span>
        <Show when={streaming()}>
          <span class="text-faint">Summarizing…</span>
        </Show>
        <span class="ml-auto shrink-0 text-[11px] text-faint">{open() ? "Hide summary" : "Show summary"}</span>
        <svg
          viewBox="0 0 16 16"
          class="size-3.5 shrink-0 transition-transform"
          classList={{ "rotate-180": open() }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="M4 6.5 8 10.5l4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="border-t border-edge px-3 py-2 text-[13px] leading-5">
          <Show when={texts().length > 0} fallback={<span class="text-[12px] text-faint">No summary yet.</span>}>
            <ClampedPreview lines={10} lineHeight={20} class="text-[13px] leading-5">
              <For each={texts()}>{(text) => <MarkdownText text={text} streaming={streaming()} />}</For>
            </ClampedPreview>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * defaultOpenTool
 * 参数：name 工具名
 * 核心流程：edit 类卡片内容本身就是主要信息，默认展开（用户手动折叠后以 overrides 为准）
 */
function defaultOpenTool(name: string): boolean {
  return /^(edit|multiedit)$/i.test(name)
}

/**
 * AssistantParts
 * 参数：message 消息（assistant/system/tool）
 * 核心流程：计算"最后一个未完成的 tool_call"作为唯一自动展开项；
 *           收集已被 tool_call 合并的 tool_result 下标集合，遍历时跳过；
 *           展开状态以 key 覆盖表（overrides）存储，避免 SSE 全量替换 parts 时丢失
 */
function AssistantParts(props: { message: TimelineMessage; showFinish?: boolean }) {
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>({})
  const subagent = useSubagentStore()

  // 消息含 finish 分片即视为生成结束（reasoning 折叠、无"运行中"工具）
  const isStreaming = createMemo(() => !props.message.parts.some((p) => p.type === "finish"))

  // 最后一条正在运行的工具：默认展开的唯一卡片
  const runningToolId = createMemo(() => {
    if (!isStreaming()) return undefined
    const calls = props.message.parts.filter((p) => p.type === "tool_call")
    const last = calls[calls.length - 1]
    const data = (last?.data ?? {}) as ToolCallPartData
    return last && !data.finished ? data.id : undefined
  })

  // 运行中文案：正文尚未出现且已有 reasoning 时显示 Thinking；否则只展示字符带
  const runningLabel = createMemo(() => {
    const hasText = props.message.parts.some((p) => p.type === "text" && partText(p).trim().length > 0)
    if (hasText) return undefined
    return props.message.parts.some((p) => p.type === "reasoning") ? "Thinking" : undefined
  })

  // 已合并进 tool_call 卡片的 tool_result 下标
  const mergedResults = createMemo(() => {
    const callIds = new Set(
      props.message.parts
        .filter((p) => p.type === "tool_call")
        .map((p) => (p.data ?? {}) as ToolCallPartData)
        .filter((d) => d.id)
        .map((d) => d.id as string),
    )
    return new Set(
      props.message.parts
        .map((p, index) => ({ p, index }))
        .filter(({ p }) => {
          if (p.type !== "tool_result") return false
          const id = ((p.data ?? {}) as ToolResultPartData).tool_call_id
          return !!id && callIds.has(id)
        })
        .map(({ index }) => index),
    )
  })

  /**
   * toggle
   * 参数：key 展开状态键；current 当前展开值
   * 核心流程：写入覆盖表取反值，优先级高于自动展开规则
   */
  function toggle(key: string, current: boolean) {
    setOverrides((prev) => ({ ...prev, [key]: !current }))
  }

  return (
    <div class="flex min-w-0 flex-col gap-1.5 text-[13px] leading-5 text-text">
      <For each={props.message.parts}>
        {(part, index) => {
          const data = (part.data ?? {}) as Record<string, unknown>
          switch (part.type) {
            case "text": {
              const text = partText(part)
              if (!text) return null
              return <MarkdownText text={text} streaming={isStreaming()} />
            }
            case "reasoning": {
              const r = data as ReasoningPartData
              const key = `reasoning:${index()}`
              const streaming = isStreaming() && !r.finished_at
              const open = () => overrides()[key] ?? streaming
              if (!r.thinking && !streaming) return null
              return (
                <ReasoningBlock open={open()} streaming={streaming} thinking={r.thinking ?? ""} onToggle={() => toggle(key, open())} />
              )
            }
            case "tool_call": {
              const tc = data as ToolCallPartData
              const name = tc.name || "tool"
              // todos 工具由底部 Todo Dock 统一展示，时间线不再重复渲染
              if (name === "todos") return null
              const key = `tool:${tc.id ?? index()}`
              // agent 卡片只在真正运行时自动展开，已完成的历史记录默认收起，避免刷屏
              const autoOpen = () => key === `tool:${runningToolId()}` && (name !== "agent" || (!tc.finished && !result))
              const open = () => overrides()[key] ?? (autoOpen() || defaultOpenTool(name))
              // 按 id 找同消息内对应 result 合并展示
              const inlineResult = props.message.parts.find((p) => {
                if (p.type !== "tool_result") return false
                return ((p.data ?? {}) as ToolResultPartData).tool_call_id === tc.id
              })
              const inlineData = inlineResult ? ((inlineResult.data ?? {}) as ToolResultPartData) : undefined
              // 结果常落在后续 tool 消息里：统一从会话级结果表补齐，
              // 否则 view/edit 这类需要 metadata 的卡片只能看到调用参数
              const crossResult = tc.id ? subagent?.toolResults().get(tc.id) : undefined
              // agent 结果同样跨消息：从会话级结果表补齐，才能停掉转圈并展示最终答复
              const result =
                name === "agent" && tc.id
                  ? (subagent?.toolResults().get(tc.id) ?? inlineData)
                  : (crossResult ?? inlineData)
              if (name === "agent") {
                return (
                  <SubagentCard
                    messageId={props.message.id}
                    toolCall={tc}
                    result={result}
                    finished={tc.finished === true}
                    open={open()}
                    onToggle={() => toggle(key, open())}
                  />
                )
              }
              return (
                <ToolCard
                  name={name}
                  inputRaw={tc.input}
                  finished={tc.finished === true}
                  result={result}
                  open={open()}
                  onToggle={() => toggle(key, open())}
                />
              )
            }
            case "tool_result": {
              if (mergedResults().has(index())) return null
              const tr = data as ToolResultPartData
              // todos 由 Todo Dock 统一展示；agent 结果由上方 SubagentCard 跨消息合并，避免重复卡片
              if ((tr.name || "") === "todos" || (tr.name || "") === "agent") return null
              // 结果消息只带 tool_call_id：反查原始调用，edit 类卡片据此展示文件路径等参数
              const origin = tr.tool_call_id ? subagent?.toolCalls().get(tr.tool_call_id) : undefined
              const name = tr.name || origin?.name || "tool"
              // edit 结果已合并进调用卡片：跳过独立结果卡，避免同一操作出现两张卡片
              if (origin && defaultOpenTool(name)) return null
              const resultKey = `result:${index()}`
              const resultOpen = () => overrides()[resultKey] ?? defaultOpenTool(name)
              return (
                <ToolCard
                  name={name}
                  inputRaw={/^(edit|multiedit)$/i.test(name) ? origin?.input : undefined}
                  finished={true}
                  result={tr}
                  open={resultOpen()}
                  onToggle={() => toggle(resultKey, resultOpen())}
                />
              )
            }
            case "shell_command": {
              const sc = data as ShellCommandPartData
              return <ShellCommandCard command={sc.command ?? ""} output={sc.output ?? ""} />
            }
            case "image_url":
            case "binary": {
              // 图片渲染缩略图；文本/其他附件（@ 引用）渲染成文件名 chip，避免误标成图片
              const src = imageSrc(part)
              if (src) return <MessageImage src={src} />
              const bin = data as BinaryPartData
              const path = bin.Path ?? ""
              const name = path.split("/").filter(Boolean).pop() ?? "attachment"
              return (
                <div
                  class="flex max-w-[260px] items-center gap-1.5 rounded-[6px] border border-edge bg-raised/40 px-2 py-1 text-[12px] text-muted"
                  title={path || name}
                >
                  <svg viewBox="0 0 16 16" class="size-3 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.4">
                    <path d="M4 2.5h5l3 3v8H4z" stroke-linejoin="round" />
                    <path d="M9 2.5v3h3" stroke-linejoin="round" />
                  </svg>
                  <span class="min-w-0 truncate">{name}</span>
                </div>
              )
            }
            case "finish": {
              // 仅最后一条消息展示结果行，且只认最后一个分片，避免多步 step 重复
              if (props.showFinish === false) return null
              if (index() !== props.message.parts.length - 1) return null
              const f = data as FinishPartData
              if (!f.reason) return null
              return <FinishLine reason={f.reason} generationMs={f.generation_ms} outputTokens={f.output_tokens} />
            }
            default:
              return null
          }
        }}
      </For>
      {/* 生成中：底部滚动字符带，表示当前回合仍在运行 */}
      <Show when={isStreaming()}>
        <RunningIndicator label={runningLabel()} />
      </Show>
    </div>
  )
}

/**
 * ReasoningBlock
 * 参数：open 展开态；streaming 是否流式生成中；thinking 思考文本；onToggle 点击回调
 * 核心流程：标题行 Thinking + 脉冲圆点（流式）+ 箭头；展开区显示灰暗小字思考文本
 *           （预览贴底，流式时始终可见最新 10 行）
 */
function ReasoningBlock(props: { open: boolean; streaming: boolean; thinking: string; onToggle: () => void }) {
  return (
    <div class="overflow-hidden rounded-[8px] border border-edge">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
        onClick={() => props.onToggle()}
      >
        <Show when={props.streaming}>
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        </Show>
        <span>Thinking</span>
        <svg
          viewBox="0 0 16 16"
          class="ml-auto size-3 shrink-0 text-faint transition-transform"
          classList={{ "rotate-90": props.open }}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={props.open && props.thinking}>
        <div class="border-t border-edge">
          <ClampedPreview
            lines={10}
            lineHeight={18}
            offset={16}
            expandedMaxHeight={420}
            tone="muted"
            anchor="bottom"
            class="px-2.5 py-2 text-[12px] leading-[18px] whitespace-pre-wrap break-words"
          >
            {props.thinking}
          </ClampedPreview>
        </div>
      </Show>
    </div>
  )
}

/**
 * ToolCard
 * 参数：name 工具名；inputRaw 原始 input；finished 是否完成；result 合并的 result（可无）；
 *       open 展开态；onToggle 点击回调
 * 核心流程：头部（图标+名称+摘要+脉冲点/箭头）可点击展开；
 *           edit/multiedit 展开态展示左右两栏 Before/After 对比；
 *           其余工具展示格式化 input JSON 与 result content（等宽、限高 320px 滚动）；
 *           result.is_error 时标题行标红
 */
function ToolCard(props: {
  name: string
  inputRaw: string | undefined
  finished: boolean
  result?: ToolResultPartData
  open: boolean
  onToggle: () => void
}) {
  const hasError = () => props.result?.is_error === true
  // edit/multiedit 展开时改用左右对比视图：取 metadata 的整文件前后内容
  const editDiff = createMemo(() =>
    props.open && !hasError() && /^(edit|multiedit)$/i.test(props.name)
      ? parseEditDiff(props.inputRaw, props.result?.metadata)
      : undefined,
  )
  // view 展开时改用代码卡：文件路径 + 行号 + 高亮，metadata 缺失时回退解析 <file> 块
  const viewData = createMemo(() =>
    props.open && !hasError() && /^view$/i.test(props.name)
      ? parseViewData(props.inputRaw, props.result?.metadata, props.result?.content)
      : undefined,
  )
  // bash 展开时改用命令/输出双块：命令按 bash 高亮，输出单独成块
  const bashData = createMemo(() =>
    props.open && /^bash$/i.test(props.name)
      ? parseBashData(props.inputRaw, props.result?.metadata, props.result?.content, hasError())
      : undefined,
  )
  const hasBody = () =>
    !!props.inputRaw || !!props.result?.content || !!editDiff() || !!viewData() || !!bashData()
  return (
    <div class="overflow-hidden rounded-[8px] border border-edge bg-base transition-colors hover:bg-raised/60">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]"
        classList={{ "text-[#e5484d]": hasError(), "text-muted": !hasError() }}
        onClick={() => props.onToggle()}
      >
        <span classList={{ "text-[#e5484d]": hasError(), "text-faint": !hasError() }}>
          {toolIcon(props.name)}
        </span>
        {/* 类型标识：按工具类别上色（Bash 绿 / Write 橙 / View 蓝 …） */}
        <span class={`shrink-0 font-semibold ${hasError() ? "text-[#e5484d]" : toolTone(props.name)}`}>
          {toolLabel(props.name)}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{toolSummary(props.name, props.inputRaw)}</span>
        <Show when={!props.finished} fallback={
          <svg
            viewBox="0 0 16 16"
            class="size-3 shrink-0 text-faint transition-transform"
            classList={{ "rotate-90": props.open }}
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        }>
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        </Show>
      </button>
      <Show when={props.open && hasBody()}>
        <div class="flex flex-col gap-2 border-t border-edge px-2.5 py-2">
          <Switch>
            <Match when={viewData()}>{(data) => <ViewCode data={data()} />}</Match>
            <Match when={bashData()}>{(data) => <BashBody data={data()} />}</Match>
            <Match when={editDiff()}>{(diff) => <EditDiff data={diff()} />}</Match>
            <Match when={true}>
              <>
                <Show when={props.inputRaw}>
                  <ClampedPreview lineHeight={18} offset={16}>
                    <pre class="md-pre">{formatJson(props.inputRaw)}</pre>
                  </ClampedPreview>
                </Show>
                <Show when={props.result?.content}>
                  <ClampedPreview lineHeight={18} offset={16}>
                    <pre class="md-pre" classList={{ "text-[#e5484d]": hasError() }}>{props.result?.content}</pre>
                  </ClampedPreview>
                </Show>
              </>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  )
}

/**
 * ShellCommandCard
 * 参数：command 命令；output 输出
 * 核心流程：$ 前缀命令行 + 输出块，均等宽字体
 */
function ShellCommandCard(props: { command: string; output: string }) {
  return (
    <div class="overflow-hidden rounded-[8px] border border-edge bg-base transition-colors hover:bg-raised/60">
      <div class="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[12px] text-text">
        <span class="shrink-0 text-accent">$</span>
        <span class="min-w-0 truncate">{props.command}</span>
      </div>
      <Show when={props.output}>
        <ClampedPreview lineHeight={18} offset={16}>
          <pre class="md-pre border-t border-edge">{props.output}</pre>
        </ClampedPreview>
      </Show>
    </div>
  )
}

/**
 * FinishLine
 * 参数：reason 结束原因；generationMs 服务端吐字耗时；outputTokens 本回合输出 token
 * 核心流程：底部一行小字展示结果文案；有记账时追加耗时（秒，一位小数）与 tok/s
 */
function FinishLine(props: { reason: string; generationMs?: number; outputTokens?: number }) {
  const seconds = typeof props.generationMs === "number" && props.generationMs > 0 ? (props.generationMs / 1000).toFixed(1) : ""
  const rate = tokenRate(props.outputTokens, props.generationMs)
  return (
    <div class="mt-0.5 text-[11px] text-faint">
      · {finishLabel(props.reason)}
      <Show when={seconds}>
        <span> · {seconds}s</span>
      </Show>
      <Show when={rate !== undefined}>
        <span> · {Math.round(rate ?? 0)} tok/s</span>
      </Show>
    </div>
  )
}

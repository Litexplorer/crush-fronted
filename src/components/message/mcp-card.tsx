/**
 * mcp-card.tsx
 * 参数：parseMcpArgs 解析 MCP 工具 input；McpArgs 渲染一次调用的全部参数
 * 核心流程：input JSON 逐键拆成「参数名 → 参数值」列表；标量单行展示，
 *           对象/数组/多行字符串走等宽预格式块（限高滚动），
 *           解析失败时回退原始字符串，参数为空时给出提示
 */
import { createMemo, For, Show } from "solid-js"

export interface McpArg {
  key: string
  value: string
  /** 结构化或多行值：用预格式块展示，保留缩进与换行 */
  block: boolean
}

// 单行阈值：超过则视为长文本，改为块级展示（避免挤爆一行）
const INLINE_LIMIT = 120
// 块级值的可视高度：超出部分内部滚动，不撑高消息行
const BLOCK_MAX_HEIGHT = 200

/**
 * formatValue
 * 参数：value 任意 JSON 值
 * 核心流程：字符串原样保留换行；对象/数组两空格缩进；数字/布尔/null 转文本
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return "null"
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * parseMcpArgs
 * 参数：inputRaw tool_call.input（JSON 字符串）
 * 核心流程：解析为对象后逐键格式化；值含换行、超长或是对象/数组时标记为块级；
 *           解析不到对象（空/流式半截 JSON）返回 undefined，由调用方走原始文本兜底
 */
export function parseMcpArgs(inputRaw: string | undefined): McpArg[] | undefined {
  const raw = (inputRaw ?? "").trim()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 流式写入中的半截 JSON：交给原始文本兜底展示
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const input = parsed as Record<string, unknown>
  return Object.keys(input).map((key) => {
    const value = formatValue(input[key])
    const block = value.includes("\n") || value.length > INLINE_LIMIT || typeof input[key] === "object"
    return { key, value, block }
  })
}

/**
 * McpArgs
 * 参数：inputRaw 原始 input
 * 核心流程：参数列表常显（与 Bash 命令一致，不展开也能看到全部参数）；
 *           无参数或解析失败时分别给出提示与原始文本
 */
export default function McpArgs(props: { inputRaw: string | undefined }) {
  const args = createMemo(() => parseMcpArgs(props.inputRaw))
  const raw = () => (props.inputRaw ?? "").trim()

  return (
    <div class="flex flex-col gap-1 border-t border-edge px-2.5 py-2">
      <Show
        when={args()}
        fallback={
          <Show
            when={raw()}
            fallback={<span class="text-[11px] text-faint">No parameters</span>}
          >
            <pre class="md-pre max-h-[200px] overflow-auto whitespace-pre-wrap break-all text-[11px]">
              {raw()}
            </pre>
          </Show>
        }
      >
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={<span class="text-[11px] text-faint">No parameters</span>}
          >
            <For each={list()}>
              {(arg) => (
                <div class="flex items-start gap-2 text-[11px] leading-[1.6]">
                  {/* 参数名固定窄列，过长省略并保留 title 全文 */}
                  <span class="w-[84px] shrink-0 truncate font-mono text-faint" title={arg.key}>
                    {arg.key}
                  </span>
                  <Show
                    when={arg.block}
                    fallback={
                      <span class="min-w-0 flex-1 font-mono whitespace-pre-wrap break-all text-text/85">
                        {arg.value}
                      </span>
                    }
                  >
                    <div class="min-w-0 flex-1 overflow-auto" style={{ "max-height": `${BLOCK_MAX_HEIGHT}px` }}>
                      <pre class="font-mono whitespace-pre-wrap break-all text-text/85">{arg.value}</pre>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        )}
      </Show>
    </div>
  )
}

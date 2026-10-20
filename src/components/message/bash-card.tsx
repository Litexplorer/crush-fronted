/**
 * bash-card.tsx
 * 参数：parseBashData 解析 bash 工具的 input/metadata/result；BashBody 渲染命令与输出
 * 核心流程：命令用 bash 语法高亮单独成块，输出单独成块并各自折叠；
 *           底部一行展示耗时、工作目录、后台 shell 与失败状态
 */
import { Show } from "solid-js"
import { parseToolInput } from "./tool-visuals"
import CodeBlock from "./code-block"

export interface BashData {
  command: string
  description?: string
  cwd?: string
  output: string
  durationMs?: number
  background: boolean
  shellId?: string
  failed: boolean
}

const COMMAND_VISIBLE_LINES = 30
const OUTPUT_VISIBLE_LINES = 10

/** ANSI 颜色/光标控制序列：终端输出带色码时先剥离，前端不做终端模拟 */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * cleanOutput
 * 参数：text 原始输出；command 本次命令
 * 核心流程：剥离 ANSI 转义与尾部 <cwd> 标注；若首行是 `$ command` 的重复回显则去掉，
 *           避免与卡片上方的命令块重复
 */
function cleanOutput(text: string, command: string): string {
  let out = text.replace(ANSI_PATTERN, "")
  out = out.replace(/<cwd>[\s\S]*?<\/cwd>\s*$/, "")
  const lines = out.split("\n")
  const first = (lines[0] ?? "").trim()
  if (first.startsWith("$ ") && command.trim().startsWith(first.slice(2).trim().slice(0, 40))) {
    lines.shift()
  }
  return lines.join("\n").trim()
}

/**
 * parseBashData
 * 参数：inputRaw 工具输入 JSON；metadata tool_result.metadata；content tool_result.content；
 *       failed 结果是否为错误
 * 核心流程：命令取 input.command；输出优先 metadata.output 否则 result.content；
 *           耗时由 start_time/end_time 相减；没有命令时返回 undefined 走通用视图
 */
export function parseBashData(
  inputRaw: string | undefined,
  metadata: string | undefined,
  content: string | undefined,
  failed: boolean,
): BashData | undefined {
  const input = parseToolInput(inputRaw)
  const command = typeof input.command === "string" ? input.command : ""
  if (!command) return undefined

  let output = content ?? ""
  let cwd = typeof input.working_dir === "string" && input.working_dir ? input.working_dir : undefined
  let durationMs: number | undefined
  let background = input.run_in_background === true
  let shellId: string | undefined

  if (metadata) {
    try {
      const meta = JSON.parse(metadata) as Record<string, unknown>
      if (typeof meta.output === "string") output = meta.output
      if (typeof meta.working_directory === "string" && meta.working_directory) cwd = meta.working_directory
      if (typeof meta.start_time === "number" && typeof meta.end_time === "number" && meta.end_time > meta.start_time) {
        durationMs = meta.end_time - meta.start_time
      }
      if (meta.background === true) background = true
      if (typeof meta.shell_id === "string" && meta.shell_id) shellId = meta.shell_id
    } catch {
      // metadata 非 JSON：沿用 result.content 作为输出
    }
  }

  return {
    command,
    description: typeof input.description === "string" && input.description ? input.description : undefined,
    cwd,
    output: cleanOutput(output, command),
    durationMs,
    background,
    shellId,
    failed,
  }
}

/**
 * BashBody
 * 参数：data 解析后的 bash 数据；expanded 是否展开（只控制输出与元信息）
 * 核心流程：命令块常显（完整命令、不点开也能看到）→ 展开后补输出块（浅底、可折叠） *           与元信息行；失败状态在收起时也保留
 */
export default function BashBody(props: { data: BashData; expanded: boolean }) {
  const seconds = () => {
    const ms = props.data.durationMs
    if (!ms || ms <= 0) return ""
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }

  return (
    <div class="flex flex-col gap-2">
      <CodeBlock
        code={props.data.command}
        language="bash"
        collapsedLines={COMMAND_VISIBLE_LINES}
        maxHeight={420}
        hint={props.data.description}
      />
      <Show when={props.expanded}>
        <Show when={props.data.output.length > 0}>
          <CodeBlock
            code={props.data.output}
            collapsedLines={OUTPUT_VISIBLE_LINES}
            maxHeight={340}
            tone="output"
          />
        </Show>
      </Show>
      {/* 失败状态无需展开即可看到，其余元信息随展开显示 */}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
        <Show when={props.data.failed}>
          <span class="text-[#e5484d]">failed</span>
        </Show>
        <Show when={props.expanded}>
          <Show when={seconds()}>
            <span>{seconds()}</span>
          </Show>
          <Show when={props.data.cwd}>
            <span class="min-w-0 truncate font-mono" title={props.data.cwd}>
              {props.data.cwd}
            </span>
          </Show>
          <Show when={props.data.background}>
            <span class="rounded-[4px] border border-edge px-1 py-0.5">background</span>
          </Show>
          <Show when={props.data.shellId}>
            <span class="font-mono">shell {props.data.shellId}</span>
          </Show>
        </Show>
      </div>
    </div>
  )
}

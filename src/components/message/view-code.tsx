/**
 * view-code.tsx
 * 参数：parseViewData 解析 view 工具的 input/metadata/result；ViewCode 渲染代码卡
 * 核心流程：优先用 tool_result.metadata（file_path + content），缺失时回退解析
 *           result.content 里的 <file> 块（剥离行号、截断提示、诊断）；
 *           头部展示路径与行号范围，正文交给 CodeBlock（行号 + 高亮 + 折叠）
 */
import { Show } from "solid-js"
import { parseToolInput } from "./tool-visuals"
import CodeBlock, { languageOf } from "./code-block"

export interface ViewData {
  filePath: string
  /** 首行行号（1-based），由 offset 或后端行号前缀推出 */
  startLine: number
  code: string
  outline?: string
  diagnostics?: string
  /** 后端提示「还有更多行」的原文 */
  moreHint?: string
}

const DEFAULT_VISIBLE_LINES = 20

/**
 * parseViewData
 * 参数：inputRaw 工具输入 JSON；metadata tool_result.metadata；content tool_result.content
 * 核心流程：metadata 有 content 时直接采用（无行号，起始行取 input.offset + 1）；
 *           否则解析 content 的 <file> 块：剥离 "行号|" 前缀、截断提示与诊断，
 *           块之前的内容视为 LSP outline；两者都拿不到代码返回 undefined
 */
export function parseViewData(
  inputRaw: string | undefined,
  metadata: string | undefined,
  content: string | undefined,
): ViewData | undefined {
  const input = parseToolInput(inputRaw)
  let filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : ""
  const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 0

  const text = content ?? ""
  const open = text.indexOf("<file>")
  const close = text.indexOf("</file>")
  const hasBlock = open !== -1 && close > open
  const outline = hasBlock ? text.slice(0, open).trim() : ""
  const diagnostics = hasBlock ? text.slice(close + "</file>".length).trim() : ""
  const moreHint = /\(File has more lines[^)]*\)/.exec(text)?.[0] ?? ""

  if (metadata) {
    try {
      const meta = JSON.parse(metadata) as Record<string, unknown>
      if (typeof meta.file_path === "string" && meta.file_path) filePath = meta.file_path
      if (typeof meta.content === "string") {
        return {
          filePath,
          startLine: offset + 1,
          code: meta.content,
          outline: outline || undefined,
          diagnostics: diagnostics || undefined,
          moreHint: moreHint || undefined,
        }
      }
    } catch {
      // metadata 非 JSON：继续走文本回退
    }
  }

  if (!hasBlock) return undefined

  const lines = text.slice(open + "<file>".length, close).split("\n")
  while (lines.length > 0 && lines[0].trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

  const code: string[] = []
  let startLine = offset + 1
  for (const line of lines) {
    if (/^\(File has more lines/.test(line.trim())) continue
    const numbered = /^\s*(\d+)\|(.*)$/.exec(line)
    if (numbered) {
      if (code.length === 0) startLine = Number(numbered[1])
      code.push(numbered[2])
      continue
    }
    code.push(line)
  }
  if (code.length === 0) return undefined

  return {
    filePath,
    startLine,
    code: code.join("\n"),
    outline: outline || undefined,
    diagnostics: diagnostics || undefined,
    moreHint: moreHint || undefined,
  }
}

/**
 * prettyPath
 * 参数：path 绝对路径
 * 核心流程：把家目录前缀折叠成 ~，便于卡片头部单行展示
 */
function prettyPath(path: string): string {
  return path.replace(/^\/root(?=\/|$)/, "~")
}

/**
 * ViewCode
 * 参数：data 解析后的 view 数据
 * 核心流程：头部展示文件路径与行号范围 → CodeBlock 渲染带行号的代码（默认折叠 20 行）
 *           → outline / 诊断各自可折叠展示
 */
export default function ViewCode(props: { data: ViewData }) {
  const totalLines = () => props.data.code.split("\n").length
  const endLine = () => props.data.startLine + totalLines() - 1

  return (
    <div class="overflow-hidden rounded-[8px] border border-edge">
      {/* 头部：路径 + 行号范围 */}
      <div class="flex items-center gap-2 border-b border-edge bg-raised/40 px-2.5 py-1.5 font-mono text-[11px]">
        <span class="min-w-0 flex-1 truncate text-text" title={props.data.filePath}>
          {prettyPath(props.data.filePath) || "file"}
        </span>
        <span class="shrink-0 text-faint">
          {props.data.startLine}–{endLine()}
        </span>
      </div>

      <Show when={props.data.outline}>
        {(outline) => (
          <details class="border-b border-edge px-2.5 py-1.5">
            <summary class="cursor-pointer text-[11px] text-faint">Outline</summary>
            <pre class="mt-1 max-h-40 overflow-auto whitespace-pre font-mono text-[11.5px] leading-5 text-muted">
              {outline()}
            </pre>
          </details>
        )}
      </Show>

      <div class="border-0 [&>div]:rounded-none [&>div]:border-0">
        <CodeBlock
          code={props.data.code}
          language={languageOf(props.data.filePath)}
          startLine={props.data.startLine}
          collapsedLines={DEFAULT_VISIBLE_LINES}
          hint={props.data.moreHint}
        />
      </div>

      <Show when={props.data.diagnostics}>
        {(diagnostics) => (
          <pre class="max-h-40 overflow-auto border-t border-edge bg-[#f5a623]/5 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-muted">
            {diagnostics()}
          </pre>
        )}
      </Show>
    </div>
  )
}

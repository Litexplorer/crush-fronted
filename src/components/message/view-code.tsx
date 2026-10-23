/**
 * view-code.tsx
 * 参数：parseViewData / parseViewImage 解析 view 工具的 input、metadata 与 media；
 *       ViewCode 渲染代码卡，ViewImage 渲染图片卡
 * 核心流程：结果带 image/* 的 base64 时走 ViewImage（缩略图 + 尺寸 + 体积）；
 *           否则优先用 tool_result.metadata（file_path + content），缺失时回退解析
 *           result.content 里的 <file> 块（剥离行号、截断提示、诊断）；
 *           头部展示路径与行号范围，正文交给 CodeBlock（行号 + 高亮 + 折叠）
 */
import { createSignal, Show } from "solid-js"
import { parseToolInput } from "./tool-visuals"
import CodeBlock, { languageOf } from "./code-block"
import HtmlPreview from "./html-preview"
import ImagePreview from "./image-preview"

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

export interface ViewImageData {
  filePath: string
  /** 后端下发的 MIME，形如 image/png */
  mime: string
  /** 下发字节数，由 metadata 或 base64 长度换算 */
  bytes: number
  /** 缩放前的原始字节数，仅在服务端压缩过时存在 */
  originalBytes?: number
  /** 服务端标注的下发尺寸，避免等图片解码后才知道宽高 */
  width?: number
  height?: number
  /** 可直接喂给 img 的 data URL */
  src: string
}

const DEFAULT_VISIBLE_LINES = 20

/**
 * base64Bytes
 * 参数：base64 原始字符串（可能无 padding）
 * 核心流程：按 3 字节/4 字符换算，再减去尾部 padding 占用的字节
 */
function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * formatBytes
 * 参数：bytes 字节数
 * 核心流程：1024 进制逐级换算到 KB/MB/GB；不足 1KB 直接给 B
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * mimeLabel
 * 参数：mime 形如 image/png
 * 核心流程：取子类型并大写（PNG / JPEG），无子类型时原样返回
 */
function mimeLabel(mime: string): string {
  const sub = mime.split("/")[1]
  return sub ? sub.toUpperCase() : mime
}

/**
 * parseImageMetadata
 * 参数：metadata tool_result.metadata 原始 JSON 串
 * 核心流程：只取 view 工具回填的图片字段（image_width/image_height/image_bytes/original_bytes），
 *           非 JSON 或缺字段时返回空对象，由调用方回退到本地换算
 */
function parseImageMetadata(metadata: string | undefined): {
  width?: number
  height?: number
  bytes?: number
  originalBytes?: number
} {
  if (!metadata) return {}
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>
    const num = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined)
    return {
      width: num(meta.image_width),
      height: num(meta.image_height),
      bytes: num(meta.image_bytes),
      originalBytes: num(meta.original_bytes),
    }
  } catch {
    return {}
  }
}

/**
 * parseViewImage
 * 参数：inputRaw 工具输入 JSON；mimeType tool_result.mime_type；data tool_result.data（base64）；
 *       metadata tool_result.metadata（服务端回填的尺寸/体积）
 * 核心流程：仅当 mime 为 image/* 且带 base64 时返回图片数据——
 *           拼成 data URL 供前端直接渲染；优先用 metadata 的尺寸与体积，
 *           metadata 缺失时再由 base64 长度换算；其余情形交给 parseViewData 走代码路线
 */
export function parseViewImage(
  inputRaw: string | undefined,
  mimeType: string | undefined,
  data: string | undefined,
  metadata?: string,
): ViewImageData | undefined {
  if (!mimeType?.startsWith("image/") || !data) return undefined
  const input = parseToolInput(inputRaw)
  const filePath =
    typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : ""
  const meta = parseImageMetadata(metadata)
  return {
    filePath,
    mime: mimeType,
    bytes: meta.bytes ?? base64Bytes(data),
    originalBytes: meta.originalBytes,
    width: meta.width,
    height: meta.height,
    src: `data:${mimeType};base64,${data}`,
  }
}

/**
 * ViewImage
 * 参数：data 解析后的图片数据
 * 核心流程：头部路径 +「MIME · 宽×高 · 体积」，服务端缩过图时补上「原图 X」→
 *           正文缩略图，点击进全屏；尺寸优先取 metadata，缺失时由 img onLoad 回填
 */
export function ViewImage(props: { data: ViewImageData }) {
  const [size, setSize] = createSignal<{ width: number; height: number }>()
  // 头部元信息：metadata 带尺寸时立即可用，否则等解码完成补齐
  const dims = () =>
    size() ??
    (props.data.width && props.data.height ? { width: props.data.width, height: props.data.height } : undefined)
  const meta = () =>
    [
      mimeLabel(props.data.mime),
      dims() ? `${dims()!.width}×${dims()!.height}` : "",
      formatBytes(props.data.bytes),
      props.data.originalBytes && props.data.originalBytes > props.data.bytes
        ? `原图 ${formatBytes(props.data.originalBytes)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ")

  return (
    <div class="overflow-hidden rounded-[8px] border border-edge">
      <div class="flex items-center gap-2 border-b border-edge bg-raised/40 px-2.5 py-1.5 font-mono text-[11px]">
        <span class="min-w-0 flex-1 truncate text-text" title={props.data.filePath}>
          {prettyPath(props.data.filePath) || "image"}
        </span>
        <span class="shrink-0 text-faint">{meta()}</span>
      </div>
      <div class="flex justify-center bg-base p-2">
        <ImagePreview
          src={props.data.src}
          alt={props.data.filePath}
          maxHeight={320}
          onSize={(value) => setSize(value)}
        />
      </div>
    </div>
  )
}

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
  // HTML 文件（或内容本身就是文档）额外提供沙箱预览
  const isHtml = () =>
    /\.(html?|xhtml)$/i.test(props.data.filePath) || /^\s*<!doctype html/i.test(props.data.code)

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

      <Show
        when={isHtml()}
        fallback={
          <div class="border-0 [&>div]:rounded-none [&>div]:border-0">
            <CodeBlock
              code={props.data.code}
              language={languageOf(props.data.filePath)}
              startLine={props.data.startLine}
              collapsedLines={DEFAULT_VISIBLE_LINES}
              hint={props.data.moreHint}
            />
          </div>
        }
      >
        {/* HTML 文件：源码 / 沙箱预览切换，预览不默认开启 */}
        <HtmlPreview
          html={props.data.code}
          filePath={props.data.filePath}
          startLine={props.data.startLine}
          hint={props.data.moreHint}
        />
      </Show>

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

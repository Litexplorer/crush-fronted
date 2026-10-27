/**
 * code-block.tsx
 * 参数：code 原始代码/输出；language highlight.js 语言；startLine 提供时显示行号列；
 *       collapsedLines 折叠行数（0 表示不折叠）；maxHeight 滚动区最大高度；
 *       hint 折叠条左侧提示文案；tone 代码区配色（code 正文 / output 输出）
 * 核心流程：按扩展名或显式语言高亮 → 行号列与代码列等宽同行渲染 →
 *           超过折叠行数时只展示前 N 行并提供展开/收起 → 悬停时右上角出现一键复制，
 *           复制的始终是完整代码（不受折叠影响）
 */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import hljs from "highlight.js/lib/common"
import { copyText } from "../../lib/clipboard"

/** 扩展名 → highlight.js 语言（common 包已注册的语言子集） */
const EXT_LANGUAGE: Record<string, string> = {
  go: "go",
  mod: "go",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  lua: "lua",
  swift: "swift",
  cs: "csharp",
  toml: "ini",
  ini: "ini",
  env: "ini",
  cfg: "ini",
}

/**
 * languageOf
 * 参数：path 文件路径
 * 核心流程：按扩展名映射 highlight.js 语言；未知扩展名返回空串（按纯文本转义）
 */
export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const language = EXT_LANGUAGE[ext] ?? ""
  return language && hljs.getLanguage(language) ? language : ""
}

/**
 * escapeHtml
 * 参数：text 原始文本
 * 核心流程：无语言可高亮时转义 HTML 特殊字符，安全地放进 innerHTML
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export default function CodeBlock(props: {
  code: string
  language?: string
  startLine?: number
  collapsedLines?: number
  maxHeight?: number
  hint?: string
  tone?: "code" | "output"
}) {
  const [expanded, setExpanded] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * handleCopy
   * 参数：无
   * 核心流程：复制完整 props.code（折叠态也复制全文）→ 成功后在按钮上显示 1.5s Copied
   */
  async function handleCopy() {
    const ok = await copyText(props.code)
    if (!ok) return
    setCopied(true)
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => setCopied(false), 1500)
  }

  onCleanup(() => clearTimeout(copyTimer))

  const lines = createMemo(() => props.code.replace(/\s+$/, "").split("\n"))
  const limit = () => props.collapsedLines ?? 0
  // 折叠只隐藏多出来的行：少于阈值时整体展示，避免“展开”按钮无意义
  const hidden = () => {
    const size = limit()
    if (size <= 0 || expanded()) return 0
    return Math.max(0, lines().length - size)
  }
  const visible = createMemo(() => {
    const size = limit()
    return size > 0 && !expanded() ? lines().slice(0, size) : lines()
  })

  const start = () => props.startLine ?? 1
  const end = () => start() + lines().length - 1

  const gutter = createMemo(() => {
    if (props.startLine === undefined) return ""
    return visible()
      .map((_, index) => String(start() + index))
      .join("\n")
  })

  const highlighted = createMemo(() => {
    const code = visible().join("\n")
    const language = props.language && hljs.getLanguage(props.language) ? props.language : ""
    return language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code)
  })

  const surface = () => (props.tone === "output" ? "bg-deep" : "bg-base")

  return (
    <div class="group relative overflow-hidden rounded-[8px] border border-edge">
      {/* 复制按钮：悬停/键盘聚焦时出现，避免常驻遮挡首行代码 */}
      <button
        type="button"
        aria-label={copied() ? "Copied" : "Copy code"}
        title={copied() ? "Copied" : "Copy code"}
        class="absolute right-1.5 top-1.5 z-10 rounded-[4px] border border-edge bg-base/90 px-1.5 py-0.5 font-mono text-[10px] text-faint opacity-0 backdrop-blur transition-opacity hover:bg-raised hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => void handleCopy()}
      >
        {copied() ? "Copied" : "Copy"}
      </button>
      <div class="md-body flex overflow-auto" style={{ "max-height": `${props.maxHeight ?? 420}px` }}>
        <Show when={props.startLine !== undefined}>
          <pre class="sticky left-0 shrink-0 select-none border-r border-edge bg-base px-2 py-2 text-right font-mono text-[11.5px] leading-5 text-faint">
            {gutter()}
          </pre>
        </Show>
        <pre class={`min-w-0 flex-1 ${surface()} px-2.5 py-2 font-mono text-[11.5px] leading-5`}>
          <code class="hljs whitespace-pre" innerHTML={highlighted()} />
        </pre>
      </div>
      <Show when={hidden() > 0 || props.hint}>
        <div class="flex items-center justify-between gap-2 border-t border-edge px-2.5 py-1.5 text-[11px] text-faint">
          <span class="min-w-0 truncate">{props.hint ?? ""}</span>
          <Show when={hidden() > 0}>
            <button
              type="button"
              class="shrink-0 rounded-[4px] px-1.5 py-0.5 text-muted transition-colors hover:bg-raised hover:text-text"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded() ? "Show less" : `Show ${hidden()} more lines`}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.startLine !== undefined}>
        <span class="sr-only">{`lines ${start()} to ${end()}`}</span>
      </Show>
    </div>
  )
}

/**
 * html-preview.tsx
 * 参数：html HTML 原文；filePath 文件路径（源码视图高亮用）；startLine 源码起始行；hint 截断提示
 * 核心流程：默认展示源码，点击 Preview 才把 HTML 交给沙箱 iframe 渲染 ——
 *           沙箱只给 allow-scripts/allow-forms，不给 allow-same-origin，
 *           渲染出的文档处于唯一不透明源，读不到父页面的存储与接口凭据。
 */
import { createSignal, Show } from "solid-js"
import CodeBlock, { languageOf } from "./code-block"

/** 预览区固定高度：沙箱内文档无法被父页面测量，统一给可读高度后由 iframe 内部滚动 */
const PREVIEW_HEIGHT = 360

export default function HtmlPreview(props: {
  html: string
  filePath?: string
  startLine?: number
  hint?: string
}) {
  const [mode, setMode] = createSignal<"source" | "preview">("source")

  /**
   * openInTab
   * 参数：无
   * 核心流程：把 HTML 转成 Blob URL 在新标签打开（独立源），打开后延时释放 URL
   */
  function openInTab() {
    const blob = new Blob([props.html], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <div class="overflow-hidden rounded-[8px] border border-edge">
      <div class="flex items-center gap-2 border-b border-edge bg-raised/40 px-2 py-1 text-[11px]">
        <div class="flex shrink-0 items-center rounded-[5px] border border-edge">
          <button
            type="button"
            class="px-1.5 py-0.5 transition-colors"
            classList={{ "bg-raised text-text": mode() === "source", "text-muted hover:text-text": mode() !== "source" }}
            onClick={() => setMode("source")}
          >
            Source
          </button>
          <button
            type="button"
            class="border-l border-edge px-1.5 py-0.5 transition-colors"
            classList={{ "bg-raised text-text": mode() === "preview", "text-muted hover:text-text": mode() !== "preview" }}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
        </div>
        <span class="min-w-0 flex-1 truncate font-mono text-faint">{props.filePath ?? ""}</span>
        <button
          type="button"
          class="shrink-0 rounded-[4px] px-1.5 py-0.5 text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={openInTab}
        >
          Open in new tab
        </button>
      </div>

      <Show
        when={mode() === "preview"}
        fallback={
          <CodeBlock
            code={props.html}
            language={languageOf(props.filePath ?? ".html")}
            startLine={props.startLine}
            collapsedLines={props.startLine !== undefined ? 20 : 30}
            hint={props.hint}
          />
        }
      >
        <iframe
          title={props.filePath ?? "HTML preview"}
          class="w-full bg-white"
          style={{ height: `${PREVIEW_HEIGHT}px` }}
          // 不给 allow-same-origin：脚本可运行但拿不到父页面的 DOM/存储/同源请求
          sandbox="allow-scripts allow-forms"
          srcdoc={props.html}
        />
      </Show>
    </div>
  )
}

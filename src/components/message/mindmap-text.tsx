/**
 * mindmap-text.tsx
 * 参数：MindmapText { text Markdown 原文, streaming 是否仍在流式输出 }
 * 核心流程：正文与思维导图两种视图 ——
 *           MindmapCanvas  按当前主题渲染 Markmap，卸载或文本变化时销毁实例
 *           MindmapText    右上角悬浮按钮切换视图，导图按需挂载，流式期间不提供入口
 */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { renderMarkmap } from "../../lib/markmap"
import { theme } from "../../lib/ui-store"
import { MarkdownText } from "./markdown"

/**
 * MindmapCanvas
 * 参数：text Markdown 原文
 * 核心流程：挂载后渲染导图；文本或主题变化时先销毁旧实例再重建；
 *           渲染失败保留错误文案，不阻塞消息其它内容
 */
function MindmapCanvas(props: { text: string }) {
  let hostRef: HTMLDivElement | undefined
  let seq = 0
  const [failure, setFailure] = createSignal<string | undefined>()

  createEffect(() => {
    const text = props.text
    const currentTheme = theme()
    const current = ++seq
    const host = hostRef
    if (!host) return

    let dispose: (() => void) | undefined
    setFailure(undefined)
    // 渲染导图：成功后登记销毁函数，序号失效或已卸载时立即释放
    renderMarkmap(host, text, currentTheme)
      .then((fn) => {
        if (current !== seq || !host.isConnected) {
          fn()
          return
        }
        dispose = fn
      })
      .catch((error: unknown) => {
        if (current !== seq) return
        host.replaceChildren()
        setFailure(error instanceof Error ? error.message : "Failed to render mindmap")
      })

    onCleanup(() => {
      dispose?.()
      host.replaceChildren()
    })
  })

  return (
    <div class="relative h-[380px] overflow-hidden rounded-md border border-edge bg-deep p-2">
      <div ref={hostRef} class="markmap-canvas h-full w-full" />
      <Show when={failure()}>
        <div class="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] text-[#e5484d]">
          {failure()}
        </div>
      </Show>
    </div>
  )
}

/**
 * MindmapText
 * 参数：text Markdown 原文；streaming 是否仍在流式输出
 * 核心流程：悬浮按钮在正文与导图之间切换；切到正文时卸载导图以释放 d3 监听
 */
export function MindmapText(props: { text: string; streaming?: boolean }) {
  const [mode, setMode] = createSignal<"text" | "mindmap">("text")

  return (
    <div class="group/mindmap relative">
      <Show when={!props.streaming}>
        <button
          type="button"
          class="absolute top-0 right-0 z-10 rounded border border-edge bg-deep px-1.5 py-0.5 text-[10px] text-faint opacity-45 transition-opacity hover:text-text hover:opacity-100 group-hover/mindmap:opacity-100"
          onClick={() => {
            // 切换视图：导图模式才创建 Markmap，避免每条消息都提前布局
            setMode(mode() === "text" ? "mindmap" : "text")
          }}
        >
          {mode() === "text" ? "Mindmap" : "Text"}
        </button>
      </Show>
      <Show
        when={mode() === "mindmap"}
        fallback={<MarkdownText text={props.text} streaming={props.streaming} />}
      >
        <MindmapCanvas text={props.text} />
      </Show>
    </div>
  )
}

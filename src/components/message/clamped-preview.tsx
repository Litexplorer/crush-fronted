/**
 * clamped-preview.tsx
 * 参数：children 内容；lines 预览行数；lineHeight 行高；offset 容器内边距；
 *       expandedMaxHeight 展开最大高度；tone 文本色调；class 附加样式
 * 核心流程：预览态按行高限高并叠加底部渐隐，展开态改为限高滚动；
 *          用 scrollHeight 实测溢出量，只有确实被裁掉时才展示展开按钮
 */
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"

interface ClampedPreviewProps {
  children: JSX.Element
  lines?: number
  lineHeight?: number
  offset?: number
  expandedMaxHeight?: number
  tone?: "muted" | "text" | "error"
  class?: string
}

export function ClampedPreview(props: ClampedPreviewProps) {
  const [expanded, setExpanded] = createSignal(false)
  const [hiddenLines, setHiddenLines] = createSignal(0)
  let box: HTMLDivElement | undefined

  const lines = () => props.lines ?? 10
  const lineHeight = () => props.lineHeight ?? 20
  const offset = () => props.offset ?? 0
  const expandedMax = () => props.expandedMaxHeight ?? 480

  const measure = () => {
    const el = box
    if (!el) return
    const body = Math.max(0, el.scrollHeight - offset())
    setHiddenLines(Math.max(0, Math.ceil(body / lineHeight()) - lines()))
  }

  // 展开态切换或内容异步更新后重新实测（流式、Mermaid、高亮都可能改变高度）
  createEffect(() => {
    expanded()
    const el = box
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
        ref={box}
        class={"relative overflow-hidden" + (props.class ? ` ${props.class}` : "")}
        classList={{
          "text-[#e5484d]": props.tone === "error",
          "text-text": props.tone === "text",
          "text-muted": props.tone === "muted",
        }}
        style={{
          "max-height": `${expanded() ? expandedMax() : lines() * lineHeight() + offset()}px`,
          "overflow-y": expanded() ? "auto" : "hidden",
        }}
      >
        {props.children}
        <Show when={!expanded() && hiddenLines() > 0}>
          <div class="clamped-fade pointer-events-none absolute inset-x-0 bottom-0 h-8" />
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

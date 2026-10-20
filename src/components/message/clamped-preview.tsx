/**
 * clamped-preview.tsx
 * 参数：children 内容；lines 预览行数；lineHeight 行高；offset 容器内边距；
 *       expandedMaxHeight 展开最大高度；tone 文本色调；class 附加样式；
 *       anchor 预览对齐方向（top 显示开头 / bottom 显示末尾）
 * 核心流程：预览态按行高限高并叠加渐隐，展开态改为限高滚动；
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
  /** 预览贴底：内容流式增长时保留最后 N 行（思考过程默认看最新内容） */
  anchor?: "top" | "bottom"
}

export function ClampedPreview(props: ClampedPreviewProps) {
  const [expanded, setExpanded] = createSignal(false)
  const [hiddenLines, setHiddenLines] = createSignal(0)
  let box: HTMLDivElement | undefined
  // 内容实测容器：贴底预览时外层用 flex 末端对齐裁掉上方内容，
  // scrollHeight 不会统计被裁掉的负向溢出，必须测内层实际高度
  let body: HTMLDivElement | undefined

  const lines = () => props.lines ?? 10
  const lineHeight = () => props.lineHeight ?? 20
  const offset = () => props.offset ?? 0
  const expandedMax = () => props.expandedMaxHeight ?? 480
  const anchorBottom = () => props.anchor === "bottom"

  const measure = () => {
    const el = body
    if (!el) return
    setHiddenLines(Math.max(0, Math.ceil(el.offsetHeight / lineHeight()) - lines()))
    // 展开态贴底：流式内容增长时保持滚动到最新一行
    if (expanded() && anchorBottom() && box) box.scrollTop = box.scrollHeight
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
    if (body) resize.observe(body)
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
          // 预览贴底：用 flex 末端对齐裁掉上方内容，只保留最后 N 行
          "display": !expanded() && anchorBottom() ? "flex" : undefined,
          "flex-direction": !expanded() && anchorBottom() ? "column" : undefined,
          "justify-content": !expanded() && anchorBottom() ? "flex-end" : undefined,
        }}
      >
        <div ref={body}>{props.children}</div>
        <Show when={!expanded() && hiddenLines() > 0}>
          <div
            class="pointer-events-none absolute inset-x-0 h-8"
            classList={{
              "clamped-fade bottom-0": !anchorBottom(),
              "clamped-fade-top top-0": anchorBottom(),
            }}
          />
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

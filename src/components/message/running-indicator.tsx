/**
 * running-indicator.tsx
 * 参数：label 可选文案（Thinking / Summarizing）
 * 核心流程：复刻 crush TUI 的运行中动画 ——
 *           15 个随机字符每 50ms 重新洗牌，颜色按字符位置形成横向渐变并随帧移动；
 *           可选文案后接跳动的省略号，表示当前回合仍在运行
 */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

/** 与 internal/ui/anim 保持一致的可滚动字符集 */
const GLYPHS = "0123456789abcdefABCDEF~!@#$£€%^&*()+=_"
const STRIP_WIDTH = 15
const FRAME_MS = 50
const ELLIPSIS_INTERVAL = 8

/**
 * glyphAt
 * 参数：frame 当前帧；index 字符下标
 * 核心流程：用整数哈希把 (frame, index) 映射到字符集，避免每帧调用 Math.random
 */
function glyphAt(frame: number, index: number): string {
  let x = (Math.imul(frame, 7919) + Math.imul(index, 104729)) >>> 0
  x ^= x >>> 13
  x = Math.imul(x, 0x5bd1e995)
  x ^= x >>> 15
  return GLYPHS[(x >>> 0) % GLYPHS.length]
}

/**
 * charColor
 * 参数：frame 当前帧；index 字符下标
 * 核心流程：色相从蓝到紫横跨整条字符带，并随帧缓慢右移形成滚动感
 */
function charColor(frame: number, index: number): string {
  return `hsl(${(205 + index * 7 + (frame % 10) * 3) % 360}deg 90% 62%)`
}

export default function RunningIndicator(props: { label?: string }) {
  const [frame, setFrame] = createSignal(0)

  // 动画时钟：50ms 一帧，组件卸载时停止
  const timer = setInterval(() => setFrame((value) => value + 1), FRAME_MS)
  onCleanup(() => clearInterval(timer))

  const cells = createMemo(() => {
    const current = frame()
    return Array.from({ length: STRIP_WIDTH }, (_, index) => ({
      char: glyphAt(current, index),
      color: charColor(current, index),
    }))
  })

  // 省略号按 TUI 节奏在 . / .. / ... / 空 之间循环，固定宽度避免抖动
  const ellipsis = createMemo(() => ".".repeat(Math.floor(frame() / ELLIPSIS_INTERVAL) % 4))

  return (
    <div class="flex items-center gap-2 text-[12px] leading-4 text-muted" role="status" aria-label="Running">
      <span class="font-mono tracking-[0.14em]" aria-hidden="true">
        <For each={cells()}>
          {(cell) => <span style={{ color: cell.color }}>{cell.char}</span>}
        </For>
      </span>
      <Show when={props.label}>
        <span class="text-faint">
          {props.label}
          <span class="inline-block w-[1.5em]">{ellipsis()}</span>
        </span>
      </Show>
    </div>
  )
}

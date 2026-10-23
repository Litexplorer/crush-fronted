/**
 * image-preview.tsx
 * 参数：src 图片地址（data URL 或 http(s)）；alt 无障碍文案；maxHeight 缩略图最大高度；
 *       onSize 图片加载完成后回报原始像素尺寸
 * 核心流程：缩略图按钮 → 点击展开全屏遮罩 → 点击遮罩或按 Esc 关闭；
 *           时间线附件与工具结果卡共用这一套交互，避免两处行为漂移
 */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

export interface ImagePreviewProps {
  src: string
  alt?: string
  /** 缩略图最大高度（px），默认 240：时间线 240、工具结果卡 320 */
  maxHeight?: number
  /** 加载完成后回报原始像素尺寸，供上层卡片头展示「宽×高」 */
  onSize?: (size: { width: number; height: number }) => void
}

const DEFAULT_MAX_HEIGHT = 240

/**
 * ImagePreview
 * 参数：props 见 ImagePreviewProps
 * 核心流程：createSignal 维护全屏开关 → 全屏期间监听 Esc → 缩略图与大图共用同一 src，
 *           缩略图 onLoad 时把 naturalWidth/naturalHeight 回报给上层
 */
export default function ImagePreview(props: ImagePreviewProps) {
  const [open, setOpen] = createSignal(false)

  // 全屏预览打开时监听 Escape：与点击遮罩一样关闭预览
  createEffect(() => {
    if (!open()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  // 图片解码完成：回报真实像素，卡片头据此显示尺寸且不依赖额外请求
  const handleLoad = (e: Event) => {
    const img = e.currentTarget as HTMLImageElement
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      props.onSize?.({ width: img.naturalWidth, height: img.naturalHeight })
    }
  }

  return (
    <>
      <button
        type="button"
        class="block max-w-full overflow-hidden rounded-lg border border-edge transition-opacity hover:opacity-90"
        onClick={() => setOpen(true)}
      >
        <img
          src={props.src}
          alt={props.alt ?? "attachment"}
          class="max-w-full object-contain"
          style={{ "max-height": `${props.maxHeight ?? DEFAULT_MAX_HEIGHT}px` }}
          onLoad={handleLoad}
        />
      </button>
      <Show when={open()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setOpen(false)}
        >
          <img src={props.src} alt={props.alt ?? "attachment"} class="max-h-full max-w-full object-contain" />
        </div>
      </Show>
    </>
  )
}

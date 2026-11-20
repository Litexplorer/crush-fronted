/**
 * image-preview.tsx
 * 参数：src 图片地址（data URL 或 http(s)）；alt 无障碍文案；maxHeight 缩略图最大高度；
 *       onSize 图片加载完成后回报原始像素尺寸
 * 核心流程：缩略图按钮 → 点击展开全屏遮罩 → 双击图片在落点放大、再次双击复位，
 *           放大后可拖动平移、可双指捏合缩放；点击遮罩空白处或按 Esc 关闭；
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
/** 双击放大的目标倍数 */
const ZOOM_SCALE = 2.5
/** 捏合允许到达的最大倍数 */
const MAX_SCALE = 5
/** 两次点击的间隔上限：超过即视为两次单击 */
const DOUBLE_TAP_MS = 300
/** 两次点击的位置容差：手指在移动端很难完全点在同一点 */
const DOUBLE_TAP_DIST = 30
/** 判定为「点击」而不是「拖动」的位移容差 */
const TAP_TOLERANCE = 10

interface Point {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * ImagePreview
 * 参数：props 见 ImagePreviewProps
 * 核心流程：createSignal 维护全屏开关、缩放倍数与平移偏移 → 全屏期间监听 Esc →
 *           指针事件统一处理单击/双击/拖动/捏合 → 缩略图 onLoad 时把
 *           naturalWidth/naturalHeight 回报给上层
 */
export default function ImagePreview(props: ImagePreviewProps) {
  const [open, setOpen] = createSignal(false)
  const [scale, setScale] = createSignal(1)
  const [offset, setOffset] = createSignal<Point>({ x: 0, y: 0 })
  // 手势进行中关掉 transform 过渡，否则拖动会有一帧延迟的拖影
  const [gesturing, setGesturing] = createSignal(false)

  let imgEl: HTMLImageElement | undefined
  let singleTapTimer: number | undefined
  let lastTap = { at: Number.NEGATIVE_INFINITY, x: 0, y: 0 }
  /** 当前按下的指针，用于区分单指拖动与双指捏合 */
  const pointers = new Map<number, Point>()
  let drag: { start: Point; last: Point; moved: boolean; startedAt: number; fromImage: boolean } | undefined
  let pinch: { startDistance: number; startScale: number; startOffset: Point } | undefined

  /**
   * resetZoom
   * 参数：无
   * 核心流程：把倍数与位移复位到初始态，关闭预览和再次双击时共用
   */
  function resetZoom() {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  /**
   * closePreview
   * 参数：无
   * 核心流程：取消待触发的单击关闭定时器后关闭遮罩
   */
  function closePreview() {
    if (singleTapTimer !== undefined) {
      window.clearTimeout(singleTapTimer)
      singleTapTimer = undefined
    }
    setOpen(false)
  }

  /**
   * clampOffset
   * 参数：next 期望的位移；s 目标倍数
   * 核心流程：按图片渲染尺寸算出放大后可平移的范围，保证图片边缘不会被拖出视口
   */
  function clampOffset(next: Point, s = scale()): Point {
    const el = imgEl
    if (!el) return next
    const maxX = (el.offsetWidth * s - el.offsetWidth) / 2
    const maxY = (el.offsetHeight * s - el.offsetHeight) / 2
    return { x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) }
  }

  /**
   * zoomAt
   * 参数：point 双击落点（视口坐标）
   * 核心流程：已放大则复位；否则以图片中心为原点换算位移，使落点下的像素放大后仍停在
   *           同一屏幕位置，视觉上就是「从这里放大」
   */
  function zoomAt(point: Point) {
    if (scale() > 1) {
      resetZoom()
      return
    }
    const el = imgEl
    if (!el) return
    const rect = el.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const next = {
      x: (point.x - centerX) * (1 - ZOOM_SCALE),
      y: (point.y - centerY) * (1 - ZOOM_SCALE),
    }
    setOffset(clampOffset(next, ZOOM_SCALE))
    setScale(ZOOM_SCALE)
  }

  /**
   * handleTap
   * 参数：point 抬起位置；fromImage 按下时是否落在图片上
   * 核心流程：落在遮罩空白处立即关闭；落在图片上时，与上一次点击凑成双击则缩放，
   *           否则延迟 DOUBLE_TAP_MS 再关闭（未放大时），给双击留出判定窗口
   */
  function handleTap(point: Point, fromImage: boolean) {
    if (!fromImage) {
      closePreview()
      return
    }

    const now = performance.now()
    const isDoubleTap =
      now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < DOUBLE_TAP_DIST
    if (isDoubleTap) {
      lastTap = { at: Number.NEGATIVE_INFINITY, x: 0, y: 0 }
      if (singleTapTimer !== undefined) {
        window.clearTimeout(singleTapTimer)
        singleTapTimer = undefined
      }
      zoomAt(point)
      return
    }

    lastTap = { at: now, x: point.x, y: point.y }
    // 已放大时单击不关闭：这时用户多半是想拖动或看细节，关闭只会误触
    if (scale() > 1) return

    if (singleTapTimer !== undefined) window.clearTimeout(singleTapTimer)
    singleTapTimer = window.setTimeout(() => {
      singleTapTimer = undefined
      setOpen(false)
    }, DOUBLE_TAP_MS)
  }

  const onPointerDown = (e: PointerEvent) => {
    const target = e.currentTarget as HTMLElement
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    target.setPointerCapture?.(e.pointerId)
    if (pointers.size === 1) {
      drag = {
        start: { x: e.clientX, y: e.clientY },
        last: { x: e.clientX, y: e.clientY },
        moved: false,
        startedAt: performance.now(),
        fromImage: e.target === imgEl,
      }
      return
    }
    if (pointers.size === 2) {
      // 第二根手指落下：放弃单指拖动，改用捏合基准距离
      drag = undefined
      const [a, b] = [...pointers.values()]
      pinch = { startDistance: Math.max(distance(a, b), 1), startScale: scale(), startOffset: offset() }
      setGesturing(true)
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()]
      const ratio = distance(a, b) / pinch.startDistance
      const nextScale = clamp(pinch.startScale * ratio, 1, MAX_SCALE)
      const grow = nextScale / pinch.startScale
      setScale(nextScale)
      setOffset(clampOffset({ x: pinch.startOffset.x * grow, y: pinch.startOffset.y * grow }, nextScale))
      return
    }

    if (!drag) return
    // 位移超过容差就记为拖动：未放大时拖动也不能在抬手后当成单击关掉预览
    if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > TAP_TOLERANCE) drag.moved = true
    if (scale() <= 1) return
    const moved = { x: offset().x + (e.clientX - drag.last.x), y: offset().y + (e.clientY - drag.last.y) }
    drag.last = { x: e.clientX, y: e.clientY }
    setGesturing(true)
    setOffset(clampOffset(moved))
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return
    if (pointers.size < 2) pinch = undefined

    if (pointers.size > 0) {
      // 捏合抬起一指：剩下那指继续按拖动处理，不再算作点击
      const [rest] = [...pointers.values()]
      drag = { start: rest, last: rest, moved: true, startedAt: performance.now(), fromImage: true }
      return
    }

    const finished = drag
    drag = undefined
    setGesturing(false)
    if (finished && !finished.moved && performance.now() - finished.startedAt < 400) {
      handleTap({ x: e.clientX, y: e.clientY }, finished.fromImage)
    }
  }

  const onPointerCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = undefined
    if (pointers.size === 0) {
      drag = undefined
      setGesturing(false)
    }
  }

  // 全屏预览打开时监听 Escape：与点击遮罩一样关闭预览
  createEffect(() => {
    if (!open()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  // 每次重新打开都从原始比例开始，避免上一张图的缩放状态残留
  createEffect(() => {
    if (open()) resetZoom()
  })

  onCleanup(() => {
    if (singleTapTimer !== undefined) window.clearTimeout(singleTapTimer)
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
          class="fixed inset-0 z-50 flex touch-none select-none items-center justify-center overflow-hidden bg-black/80 p-6"
          role="dialog"
          aria-modal="true"
          aria-label={props.alt ?? "Image preview"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <img
            ref={imgEl}
            src={props.src}
            alt={props.alt ?? "attachment"}
            draggable={false}
            class="max-h-full max-w-full object-contain"
            classList={{ "cursor-zoom-in": scale() === 1, "cursor-zoom-out": scale() > 1 }}
            style={{
              transform: `translate3d(${offset().x}px, ${offset().y}px, 0) scale(${scale()})`,
              transition: gesturing() ? "none" : "transform 180ms ease-out",
              "will-change": "transform",
            }}
          />
        </div>
      </Show>
    </>
  )
}

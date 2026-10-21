/**
 * virtual-timeline.tsx
 * 参数：items 条目 id 列表（顺序即展示顺序）；render 按 id 渲染单项；scroll 滚动容器访问器；
 *       pin 需要强制渲染的条目 id（跳转定位用）；stick 是否贴底跟随新消息；
 *       onAutoScroll 程序化滚到底前的回调（父级据此区分用户滚动与跟随滚动）；
 *       estimate 未测量条目的初始估算高度；overscan 视口外多渲染的条数；gap 条目间距
 * 核心流程：只挂载视口附近（含 overscan）的条目，其余用占位高度撑开滚动区域 ——
 *           实测高度按 id 缓存（ResizeObserver 回写，变化超过容差才重算）；
 *           未测过的条目在首次进入布局时锁定一个估算值，避免全局平均值变动导致整篇高度抖动；
 *           滚动位置按帧批处理；贴底状态下新消息或高度变化后重新滚到底部。
 * 渲染行以 id 为标识：上层消息对象更新（流式分片）时复用同一行，不重建 DOM。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, type JSX } from "solid-js"

export interface VirtualTimelineProps {
  items: string[]
  render: (id: string, index: () => number) => JSX.Element
  scroll: () => HTMLDivElement | undefined
  pin?: string
  stick?: () => boolean
  onAutoScroll?: () => void
  estimate?: number
  overscan?: number
  gap?: number
}

const DEFAULT_ESTIMATE = 120
const DEFAULT_OVERSCAN = 6
const DEFAULT_GAP = 16
const MEASURE_TOLERANCE = 0.5
/** 贴底判定：距底部小于该值即视为已在底部，不再写入 scrollTop，避免无谓滚动事件 */
const BOTTOM_EPSILON = 1

export default function VirtualTimeline(props: VirtualTimelineProps) {
  const estimate = () => props.estimate ?? DEFAULT_ESTIMATE
  const overscan = () => props.overscan ?? DEFAULT_OVERSCAN
  const gap = () => props.gap ?? DEFAULT_GAP

  /** 实测高度：id → px */
  const measured = new Map<string, number>()
  /** 首次布局时锁定的估算高度：id → px，避免全局平均变化让未测条目反复缩放 */
  const estimated = new Map<string, number>()
  let measuredTotal = 0

  const [revision, setRevision] = createSignal(0)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(0)

  /**
   * recordHeight
   * 参数：id 条目 id；height 实测高度
   * 核心流程：与缓存差值超过容差才写入并自增 revision，避免测量→重算→测量的抖动循环
   */
  function recordHeight(id: string, height: number) {
    const prev = measured.get(id)
    if (prev !== undefined && Math.abs(prev - height) <= MEASURE_TOLERANCE) return
    if (prev !== undefined) measuredTotal -= prev
    measured.set(id, height)
    measuredTotal += height
    setRevision((value) => value + 1)
  }

  /** 未测条目的估算高度：优先用已测平均值，没有样本时回退固定值 */
  const averageHeight = () => (measured.size > 0 ? measuredTotal / measured.size : estimate())

  /**
   * sizeOf
   * 参数：id 条目 id
   * 核心流程：实测值优先；未测条目在首次进入布局时锁定当前平均值，
   *           之后不再随平均值变化，保证整篇高度稳定（只有该条目被实测时才修正）
   */
  function sizeOf(id: string): number {
    const height = measured.get(id)
    if (height !== undefined) return height
    const seeded = estimated.get(id)
    if (seeded !== undefined) return seeded
    const fresh = averageHeight()
    estimated.set(id, fresh)
    return fresh
  }

  /**
   * trackItem
   * 参数：el 条目包裹元素；id 条目 id
   * 核心流程：用 ResizeObserver 测量高度（首次回调即布局后的真实尺寸），
   *           不在挂载时同步读 offsetHeight，避免元素未插入文档时把 0 写进缓存
   */
  function trackItem(el: HTMLDivElement, id: string) {
    const observer = new ResizeObserver(() => recordHeight(id, el.offsetHeight))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  }

  // 滚动容器：订阅滚动位置与可视高度；滚动回调按帧批处理，避免每个像素都触发重渲染
  createEffect(() => {
    const el = props.scroll()
    if (!el) return
    let frame = 0
    const read = () => {
      frame = 0
      setScrollTop(el.scrollTop)
      setViewport(el.clientHeight)
    }
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(read)
    }
    read()
    el.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => {
      el.removeEventListener("scroll", update)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    })
  })

  /** 条目清理：消息被删（SSE deleted）时清掉高度缓存，避免 Map 与总和无限增长 */
  createEffect(() => {
    props.items
    if (measured.size === 0 && estimated.size === 0) return
    const alive = new Set(props.items)
    for (const [id, height] of measured) {
      if (alive.has(id)) continue
      measured.delete(id)
      measuredTotal -= height
    }
    for (const id of estimated.keys()) {
      if (!alive.has(id)) estimated.delete(id)
    }
  })

  const layout = createMemo(() => {
    revision()
    const ids = props.items
    const sizes: number[] = new Array(ids.length)
    const offsets: number[] = new Array(ids.length)
    let total = 0
    for (let i = 0; i < ids.length; i++) {
      sizes[i] = sizeOf(ids[i])
      offsets[i] = total
      total += sizes[i]
      // 末条不计间距：滚动高度与最后一条内容底部对齐
      if (i < ids.length - 1) total += gap()
    }
    return { sizes, offsets, total }
  })

  const range = createMemo(() => {
    const ids = props.items
    const count = ids.length
    if (count === 0) return { start: 0, end: -1, top: 0, bottom: 0 }
    const { sizes, offsets, total } = layout()
    const top = scrollTop()
    const bottom = top + (viewport() || 800)

    // 二分定位首个「底边越过视口顶部」的条目
    let lo = 0
    let hi = count - 1
    let first = count - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] + sizes[mid] >= top) {
        first = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    let last = first
    while (last + 1 < count && offsets[last + 1] < bottom) last++

    let start = Math.max(0, first - overscan())
    let end = Math.min(count - 1, last + overscan())

    // 跳转目标不在窗口内：把窗口挪到目标附近，等实测后由调用方做精确定位
    const pin = props.pin
    if (pin) {
      const pinIndex = ids.indexOf(pin)
      if (pinIndex >= 0 && (pinIndex < start || pinIndex > end)) {
        start = Math.max(0, pinIndex - overscan())
        end = Math.min(count - 1, pinIndex + overscan())
      }
    }

    const topSpacer = offsets[start] ?? 0
    const bottomSpacer = end + 1 < count ? total - (offsets[end + 1] ?? total) : 0
    return { start, end, top: topSpacer, bottom: bottomSpacer }
  })

  // 贴底跟随：新消息或高度实测后滚到底部（requestAnimationFrame 避开同一帧内的占位尺寸）
  createEffect(() => {
    props.items.length
    revision()
    if (!props.stick?.()) return
    const el = props.scroll()
    if (!el) return
    requestAnimationFrame(() => {
      if (!el.isConnected) return
      // 等帧期间用户可能已上翻：放弃本次跟随，避免把用户拽回底部
      if (!props.stick?.()) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance <= BOTTOM_EPSILON) return
      // 告知父级：本次滚动是跟随行为，滚动监听不要据此判定“用户上翻了”
      props.onAutoScroll?.()
      el.scrollTop = el.scrollHeight
    })
  })

  /** 条目 → 下标：渲染行需要知道自己在全局列表中的位置（用于末条判定等） */
  const indexOf = createMemo(() => {
    const map = new Map<string, number>()
    props.items.forEach((id, index) => map.set(id, index))
    return map
  })

  const visibleIds = createMemo(() => {
    const { start, end } = range()
    return props.items.slice(start, end + 1)
  })

  return (
    <>
      <div style={{ height: `${range().top}px` }} aria-hidden="true" />
      <For each={visibleIds()}>
        {(id) => {
          // 末条不占间距：与占位高度算法保持一致
          const margin = () => (indexOf().get(id) === props.items.length - 1 ? "0px" : `${gap()}px`)
          return (
            <div ref={(el) => trackItem(el, id)} style={{ "margin-bottom": margin() }}>
              {props.render(id, () => indexOf().get(id) ?? 0)}
            </div>
          )
        }}
      </For>
      <div style={{ height: `${range().bottom}px` }} aria-hidden="true" />
    </>
  )
}

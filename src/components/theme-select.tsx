/**
 * theme-select.tsx
 * 参数：trigger 触发形态（icon 标题栏图标 / field 设置面板表单行）
 * 核心流程：主题下拉 ——
 *           按钮展开浮层（Portal 到 body，避免被设置面板滚动容器裁剪）→
 *           搜索框按名称/id 过滤 → ↑↓ 移动、Enter 选中、Esc 收起 →
 *           每行左侧双色块预览，选中即切换主题并把焦点还给按钮
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { setTheme, theme } from "../lib/ui-store"
import { themeLabel, themeMode, THEMES, type ThemeDef } from "../lib/themes"

/** icon 形态浮层宽度：标题栏按钮本身只有 28px，固定成便于扫读的宽度 */
const ICON_MENU_WIDTH = 264

export default function ThemeSelect(props: { trigger?: "icon" | "field" }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [anchor, setAnchor] = createSignal({ left: 8, top: 0, width: ICON_MENU_WIDTH })
  let rootRef: HTMLDivElement | undefined
  let buttonRef: HTMLButtonElement | undefined
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let menuRef: HTMLDivElement | undefined

  /** 设置面板形态：按钮展示当前主题名并撑满整行 */
  const isField = () => props.trigger === "field"

  /** 过滤后的主题：名称或 id 命中即可，空查询给全量 */
  const filtered = createMemo<ThemeDef[]>(() => {
    const q = query().trim().toLowerCase()
    if (!q) return THEMES
    return THEMES.filter((item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q))
  })

  /** 当前主题的双色块预览 */
  const currentPreview = () => THEMES.find((item) => item.id === theme())?.preview

  /** 展开：按触发按钮位置定位浮层，并把选中行落在当前主题上 */
  function openMenu() {
    const rect = buttonRef?.getBoundingClientRect()
    const width = isField() ? (rect?.width ?? ICON_MENU_WIDTH) : ICON_MENU_WIDTH
    const left = isField() ? (rect?.left ?? 8) : (rect?.right ?? width + 8) - width
    setAnchor({ left: Math.max(8, left), top: (rect?.bottom ?? 0) + 4, width })
    setQuery("")
    setActive(Math.max(0, THEMES.findIndex((item) => item.id === theme())))
    setOpen(true)
    queueMicrotask(() => inputRef?.focus())
  }

  /** 收起：默认把焦点还给触发按钮，点击外部收起时不动焦点 */
  function close(refocus = true) {
    setOpen(false)
    if (refocus) queueMicrotask(() => buttonRef?.focus())
  }

  /** 选中一行：立即切换主题并收起 */
  function pick(item: ThemeDef | undefined) {
    if (!item) return
    setTheme(item.id)
    close()
  }

  /** 搜索框键盘：↑↓ 移动、Enter 选中、Esc 收起，其余按键留给输入 */
  function handleKeyDown(event: KeyboardEvent) {
    const list = filtered()
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (list.length === 0) return
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        setActive((index) => (index + 1) % list.length)
        break
      case "ArrowUp":
        event.preventDefault()
        setActive((index) => (index - 1 + list.length) % list.length)
        break
      case "Enter":
        event.preventDefault()
        pick(list[active()])
        break
    }
  }

  // 点击浮层或按钮之外的区域收起；浮层在 Portal 里，需要单独判断
  createEffect(() => {
    if (!open()) return
    const onPointerDown = (event: MouseEvent) => {
      const node = event.target as Node
      if (rootRef?.contains(node) || menuRef?.contains(node)) return
      close(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    onCleanup(() => document.removeEventListener("mousedown", onPointerDown))
  })

  // 页面滚动/缩放会让固定定位失效，直接收起而不是追着重新定位；
  // 列表自身的滚动不算页面滚动，否则鼠标滚轮滚一下候选就会被关掉
  createEffect(() => {
    if (!open()) return
    const onMove = (event: Event) => {
      const target = event.target
      if (event.type === "scroll" && target instanceof Node && menuRef?.contains(target)) return
      close(false)
    }
    window.addEventListener("resize", onMove)
    window.addEventListener("scroll", onMove, true)
    onCleanup(() => {
      window.removeEventListener("resize", onMove)
      window.removeEventListener("scroll", onMove, true)
    })
  })

  // 选中行变化时滚动到可见区域
  createEffect(() => {
    const index = active()
    if (!open()) return
    listRef?.querySelector<HTMLElement>(`[data-theme-row="${index}"]`)?.scrollIntoView({ block: "nearest" })
  })

  return (
    <div ref={rootRef} classList={{ relative: true, "min-w-0": isField() }}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={`Theme: ${themeLabel(theme())}`}
        title={`Theme: ${themeLabel(theme())}`}
        class="flex items-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
        classList={{
          "size-7 justify-center": !isField(),
          "w-full justify-between gap-2 border border-edge px-2.5 py-1 text-[12px] text-text": isField(),
        }}
        onClick={() => (open() ? close() : openMenu())}
      >
        <Show
          when={!isField()}
          fallback={
            <>
              <span class="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  class="size-3.5 shrink-0 rounded-[3px] border-2"
                  style={{
                    "background-color": currentPreview()?.bg ?? "transparent",
                    "border-color": currentPreview()?.accent ?? "transparent",
                  }}
                />
                <span class="truncate">{themeLabel(theme())}</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-3 shrink-0 text-faint" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </>
          }
        >
          <Show
            when={themeMode(theme()) === "dark"}
            fallback={
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
                <circle cx="8" cy="8" r="2.6" />
                <path
                  d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"
                  stroke-linecap="round"
                />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M13.2 9.6A5.4 5.4 0 1 1 6.4 2.8a4.4 4.4 0 0 0 6.8 6.8Z" stroke-linejoin="round" />
            </svg>
          </Show>
        </Show>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: `${anchor().left}px`,
              top: `${anchor().top}px`,
              width: `${anchor().width}px`,
            }}
            class="z-50 flex max-h-[360px] flex-col overflow-hidden rounded-lg border border-edge bg-deep shadow-xl"
          >
            <div class="shrink-0 border-b border-edge p-1.5">
              <input
                ref={inputRef}
                value={query()}
                role="combobox"
                aria-expanded="true"
                aria-controls="theme-select-list"
                aria-autocomplete="list"
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  setActive(0)
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search themes…"
                class="w-full rounded-[4px] bg-transparent px-1.5 py-1 text-[12px] leading-4 text-text outline-none placeholder:text-faint"
              />
            </div>

            <div ref={listRef} id="theme-select-list" role="listbox" aria-label="Themes" class="min-h-0 flex-1 overflow-y-auto p-1">
              <For each={filtered()}>
                {(item, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={theme() === item.id}
                    data-theme-row={index()}
                    class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[12px] text-text transition-colors hover:bg-raised"
                    classList={{ "bg-raised": active() === index() }}
                    onMouseEnter={() => setActive(index())}
                    onClick={() => pick(item)}
                  >
                    {/* 双色块：底色 + 强调色边框，快速区分同色系主题 */}
                    <span
                      aria-hidden="true"
                      class="size-3.5 shrink-0 rounded-[3px] border-2"
                      style={{ "background-color": item.preview.bg, "border-color": item.preview.accent }}
                    />
                    <span class="min-w-0 flex-1 truncate">{item.label}</span>
                    <Show when={theme() === item.id}>
                      <svg viewBox="0 0 16 16" class="size-3 shrink-0 text-accent" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="m3.5 8.5 3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </Show>
                    <span class="shrink-0 text-[10px] text-faint">{item.mode}</span>
                  </button>
                )}
              </For>
              <Show when={filtered().length === 0}>
                <div class="px-2 py-3 text-center text-[11px] text-faint">No matches</div>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

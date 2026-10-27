/**
 * shortcut-help.tsx
 * 参数：无（开关与关闭函数来自全局 ui-store）
 * 核心流程：前缀 + ? 唤起的快捷键速查表 ——
 *           按「标签与导航 / 会话输入 / 浮层」分组列出全部组合键，Esc 或点击遮罩关闭
 */
import { For, Show, onCleanup, onMount } from "solid-js"
import { closeShortcutHelp, shortcutHelpOpen } from "../lib/ui-store"

interface ShortcutRow {
  /** 每组按键；多段组合按键依次展示，用箭头分隔 */
  keys: string[]
  description: string
}

interface ShortcutSection {
  title: string
  rows: ShortcutRow[]
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "标签与导航",
    rows: [
      { keys: ["Ctrl", "B"], description: "进入前缀待命（输入框里同样生效）" },
      { keys: ["前缀", "←/→"], description: "切换标签（纵向布局为 ↑/↓）" },
      { keys: ["前缀", "Shift", "←/→"], description: "按项目跳转分组" },
      { keys: ["前缀", "N"], description: "新建会话（追加标签）" },
      { keys: ["前缀", "G"], description: "列出已打开标签（可搜索）" },
      { keys: ["前缀", "?"], description: "显示本说明" },
      { keys: ["Ctrl", "K"], description: "命令面板：搜索会话与动作" },
      { keys: ["Ctrl", "Shift", "N"], description: "新建会话并覆盖当前标签" },
    ],
  },
  {
    title: "会话输入",
    rows: [
      { keys: ["Enter"], description: "发送消息" },
      { keys: ["Shift", "Enter"], description: "换行" },
      { keys: ["↑/↓"], description: "回溯历史消息（输入框内、非浮层时）" },
      { keys: ["Ctrl", "Alt", "I"], description: "打开会话信息" },
    ],
  },
  {
    title: "浮层",
    rows: [
      { keys: ["↑/↓"], description: "在列表中移动选择" },
      { keys: ["Enter"], description: "执行选中项 / 打开选中标签" },
      { keys: ["Esc"], description: "关闭当前浮层" },
    ],
  },
]

export default function ShortcutHelp() {
  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：打开时 Esc 关闭，避免与页面其它快捷键叠加
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!shortcutHelpOpen() || event.key !== "Escape") return
      event.preventDefault()
      closeShortcutHelp()
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  return (
    <Show when={shortcutHelpOpen()}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onClick={closeShortcutHelp}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          class="flex max-h-[72vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="flex shrink-0 items-center justify-between border-b border-edge px-3 py-2">
            <h2 class="text-[13px] font-semibold text-text">快捷键</h2>
            <button
              type="button"
              aria-label="Close shortcuts"
              class="flex size-6 items-center justify-center rounded text-muted transition-colors hover:bg-raised hover:text-text"
              onClick={closeShortcutHelp}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <For each={SECTIONS}>
              {(section) => (
                <section class="mb-3 last:mb-0">
                  <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">{section.title}</h3>
                  <ul class="flex flex-col gap-1">
                    <For each={section.rows}>
                      {(row) => (
                        <li class="flex items-center gap-3 rounded px-1 py-0.5 text-[12px]">
                          <span class="flex w-[150px] shrink-0 items-center gap-1">
                            <For each={row.keys}>
                              {(key, index) => (
                                <>
                                  <Show when={index() > 0}>
                                    <span class="text-faint" aria-hidden="true">+</span>
                                  </Show>
                                  <kbd class="rounded border border-edge bg-raised px-1 py-0.5 font-sans text-[10px] text-text">
                                    {key}
                                  </kbd>
                                </>
                              )}
                            </For>
                          </span>
                          <span class="min-w-0 flex-1 text-muted">{row.description}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </div>
          <div class="shrink-0 border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            前缀 = 先按 Ctrl+B，再按后面的键
          </div>
        </div>
      </div>
    </Show>
  )
}

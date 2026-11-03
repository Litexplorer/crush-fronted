/**
 * app.tsx
 * 参数：无（接收路由 children）
 * 核心流程：App 骨架 ——
 *           横向标签栏：Titlebar（36px）+ 主内容区上下排列；
 *           纵向标签栏：改为「左侧标签栏 + 右侧（顶栏 + 内容）」的网格布局，
 *                       收起时首列补间到 28px，只留竖轨；
 *           两种布局共用同一个 Titlebar 实例，避免标签状态分裂；
 *           额外挂几个全局浮层：右下角完成通知、Ctrl+K 命令面板、标签列表、历史会话、本会话提问、模型列表、快捷键说明
 */
import { onCleanup, onMount, type ParentProps } from "solid-js"
import Titlebar from "./components/titlebar"
import ServerBanner from "./components/server-banner"
import NotificationCenter from "./components/notification-center"
import CommandPalette from "./components/command-palette"
import TabSwitcher from "./components/tab-switcher"
import HistoryDialog from "./components/history-dialog"
import QuestionDialog from "./components/question-dialog"
import ModelDialog from "./components/model-dialog"
import ShortcutHelp from "./components/shortcut-help"
import { closeCommandPalette, commandPaletteOpen, tabsCollapsed, tabsOrientation, toggleCommandPalette } from "./lib/ui-store"
import { isMobile } from "./lib/viewport"
import { startServerStatusPolling } from "./lib/server-status"

export default function App(props: ParentProps) {
  // 纵向标签栏固定占 196px 宽，窄屏会把内容区压没，移动端一律按横向排布
  const vertical = () => tabsOrientation() === "vertical" && !isMobile()

  onMount(() => {
    // 启动全局服务端状态轮询：顶栏圆点与顶部提示条共用同一份状态
    startServerStatusPolling()

    /**
     * handlePaletteShortcut
     * 参数：event 键盘事件
     * 核心流程：Ctrl/Cmd+K 开关命令面板；输入法组词、带 Shift/Alt 的组合键不接管
     */
    const handlePaletteShortcut = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "k") return
      event.preventDefault()
      toggleCommandPalette()
    }
    document.addEventListener("keydown", handlePaletteShortcut)
    onCleanup(() => document.removeEventListener("keydown", handlePaletteShortcut))
  })

  return (
    <div
      class="select-none bg-deep text-text"
      classList={{
        "flex min-h-0 min-w-0 flex-1 flex-col": !vertical(),
        "grid min-h-0 min-w-0 flex-1 grid-rows-[36px_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out": vertical(),
      }}
      style={
        vertical()
          ? { "grid-template-columns": tabsCollapsed() ? "28px minmax(0, 1fr)" : "196px minmax(0, 1fr)" }
          : undefined
      }
    >
      <Titlebar />
      <main
        class="flex min-h-0 min-w-0 flex-1 select-text flex-col overflow-hidden [&_input]:select-text [&_textarea]:select-text"
        classList={{ "col-start-2 row-start-2": vertical() }}
      >
        {/* 服务端不可用 / 换过二进制时的顶部提示条 */}
        <ServerBanner />
        {props.children}
      </main>
      {/* 会话完成通知：右下角气泡，独立于页面内容，避免切页丢失 */}
      <NotificationCenter />
      {/* 命令面板：跨页面可用，按 Ctrl+K 唤起 */}
      <CommandPalette open={commandPaletteOpen()} onClose={closeCommandPalette} />
      {/* 标签列表（前缀 + G）、历史会话、本会话提问（前缀 + Q）、快捷键说明（前缀 + ?） */}
      <TabSwitcher />
      <HistoryDialog />
      <QuestionDialog />
      {/* 模型列表：前缀 + M，可搜索切换当前工作区模型 */}
      <ModelDialog />
      <ShortcutHelp />
    </div>
  )
}

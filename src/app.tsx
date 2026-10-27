/**
 * app.tsx
 * 参数：无（接收路由 children）
 * 核心流程：App 骨架 ——
 *           横向标签栏：Titlebar（36px）+ 主内容区上下排列；
 *           纵向标签栏：改为「左侧标签栏 + 右侧（顶栏 + 内容）」的网格布局；
 *           两种布局共用同一个 Titlebar 实例，避免标签状态分裂
 */
import { type ParentProps } from "solid-js"
import Titlebar from "./components/titlebar"
import NotificationCenter from "./components/notification-center"
import { tabsOrientation } from "./lib/ui-store"

export default function App(props: ParentProps) {
  const vertical = () => tabsOrientation() === "vertical"
  return (
    <div
      class="select-none bg-deep text-text"
      classList={{
        "flex min-h-0 min-w-0 flex-1 flex-col": !vertical(),
        "grid min-h-0 min-w-0 flex-1 grid-cols-[196px_minmax(0,1fr)] grid-rows-[36px_minmax(0,1fr)]": vertical(),
      }}
    >
      <Titlebar />
      <main
        class="flex min-h-0 min-w-0 flex-1 select-text flex-col overflow-hidden [&_input]:select-text [&_textarea]:select-text"
        classList={{ "col-start-2 row-start-2": vertical() }}
      >
        {props.children}
      </main>
      {/* 会话完成通知：右下角气泡，独立于页面内容，避免切页丢失 */}
      <NotificationCenter />
    </div>
  )
}

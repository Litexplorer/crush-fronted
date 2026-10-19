/**
 * app.tsx
 * 参数：无（接收路由 children）
 * 核心流程：App 骨架 = Titlebar（36px）+ 主内容区，children 由 @solidjs/router 注入
 */
import { type ParentProps } from "solid-js"
import Titlebar from "./components/titlebar"

export default function App(props: ParentProps) {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col select-none bg-deep text-text">
      <Titlebar />
      <main class="flex min-h-0 min-w-0 flex-1 select-text flex-col overflow-hidden [&_input]:select-text [&_textarea]:select-text">
        {props.children}
      </main>
    </div>
  )
}

/**
 * routes.tsx
 * 参数：无
 * 核心流程：声明三条路由 ——
 *           /                                首页（未选中工作区）
 *           /w/:workspaceId                  首页（选中工作区，URL 可刷新恢复）
 *           /w/:workspaceId/session/:sessionId 会话页
 */
import { Route, Router } from "@solidjs/router"
import type { ParentProps } from "solid-js"
import App from "./app"
import Home from "./pages/home"
import Session from "./pages/session"

export default function Routes() {
  return (
    <Router root={(props: ParentProps) => <App>{props.children}</App>}>
      <Route path="/" component={Home} />
      <Route path="/w/:workspaceId" component={Home} />
      <Route path="/w/:workspaceId/session/:sessionId" component={Session} />
    </Router>
  )
}

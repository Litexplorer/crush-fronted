/**
 * main.tsx
 * 参数：无
 * 核心流程：挂载 index.css 与路由根组件 Routes，渲染到 #root
 */
import { render } from "solid-js/web"
import Routes from "./routes"
import "katex/dist/katex.min.css"
import "./index.css"

/**
 * render
 * 参数：Routes 路由根组件
 * 核心流程：注入到 index.html 的 #root 节点
 */
const root = document.getElementById("root")

if (!root) {
  throw new Error("未找到 #root 挂载节点")
}

render(() => <Routes />, root)

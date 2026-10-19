/**
 * mermaid.ts
 * 核心流程：Mermaid 懒加载与渲染 ——
 *           loadMermaid    首次使用时动态 import，避免主包体积膨胀
 *           renderMermaid  串行 parse/render，返回 SVG 与绑定函数
 *           主题配置读取 CSS 变量，暗色/亮色切换后重新初始化
 */
import type { Theme } from "./ui-store"
import { randomUuid } from "./clientId"

type MermaidApi = typeof import("mermaid").default

/** 单个图的渲染结果：SVG 文本 + Mermaid 交互绑定函数 */
export interface MermaidRenderResult {
  svg: string
  bindFunctions?: (element: Element) => void
}

let mermaidPromise: Promise<MermaidApi> | undefined
let initializedTheme: Theme | undefined

/** 全局串行队列：Mermaid 使用全局临时 DOM，多图并发会互相污染 */
let renderChain: Promise<unknown> = Promise.resolve()

/**
 * enqueue
 * 参数：task 待执行的异步渲染任务
 * 核心流程：把任务追加到全局 Promise 链尾部，失败不阻断后续任务
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = renderChain.then(task, task)
  renderChain = next.catch(() => undefined)
  return next
}

/**
 * cssVar
 * 参数：name CSS 变量名
 * 核心流程：读取根元素计算样式；缺失时返回中性灰，保证 Mermaid 可渲染
 */
function cssVar(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || "#888888"
}

/**
 * buildConfig
 * 核心流程：base 主题 + CSS 变量生成图表配色，strict 禁止脚本与 HTML 标签
 */
function buildConfig() {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    htmlLabels: false,
    theme: "base" as const,
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    themeVariables: {
      background: cssVar("--bg-deep"),
      primaryColor: cssVar("--bg-raised"),
      primaryTextColor: cssVar("--text-base"),
      primaryBorderColor: cssVar("--border-strong"),
      secondaryColor: cssVar("--bg-raised"),
      secondaryTextColor: cssVar("--text-base"),
      secondaryBorderColor: cssVar("--border-base"),
      tertiaryColor: cssVar("--bg-base"),
      tertiaryTextColor: cssVar("--text-base"),
      tertiaryBorderColor: cssVar("--border-base"),
      lineColor: cssVar("--text-muted"),
      textColor: cssVar("--text-base"),
      edgeLabelBackground: cssVar("--bg-base"),
      clusterBkg: cssVar("--bg-base"),
      clusterBorder: cssVar("--border-strong"),
      titleColor: cssVar("--text-base"),
      fontSize: "12px",
    },
  }
}

/**
 * loadMermaid
 * 参数：theme 当前界面主题
 * 核心流程：动态 import 并缓存模块；主题变化时重新 initialize
 */
async function loadMermaid(theme: Theme): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((module) => module.default)
  }
  const mermaid = await mermaidPromise
  if (initializedTheme !== theme) {
    mermaid.initialize(buildConfig())
    initializedTheme = theme
  }
  return mermaid
}

/**
 * renderMermaid
 * 参数：source Mermaid 源码；theme 当前界面主题
 * 核心流程：进入全局串行队列 → 初始化 → parse 校验 → render 生成 SVG；
 *           失败抛错给调用方展示源码降级
 */
export function renderMermaid(source: string, theme: Theme): Promise<MermaidRenderResult> {
  return enqueue(async () => {
    const mermaid = await loadMermaid(theme)
    const parsed = await mermaid.parse(source, { suppressErrors: true })
    if (!parsed) throw new Error("Mermaid syntax error")

    const id = `mermaid-${randomUuid()}`
    try {
      const result = await mermaid.render(id, source)
      return { svg: result.svg, bindFunctions: result.bindFunctions }
    } finally {
      // 清理 Mermaid 可能遗留的临时节点
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
}

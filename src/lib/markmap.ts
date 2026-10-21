/**
 * markmap.ts
 * 核心流程：Markdown 思维导图渲染 ——
 *           loadMarkmap     首次使用时并行 import markmap-lib / markmap-view
 *           sanitizeTree    节点内容会被 innerHTML 写入 SVG，逐个清洗
 *           renderMarkmap   在目标容器内建 svg，交给 Markmap 布局，返回销毁函数
 */
import DOMPurify from "dompurify"
import { themeMode, type Theme } from "./themes"

type MarkmapLib = typeof import("markmap-lib")
type MarkmapView = typeof import("markmap-view")
type PureNode = ReturnType<InstanceType<MarkmapLib["Transformer"]>["transform"]>["root"]

interface MarkmapRuntime {
  lib: MarkmapLib
  view: MarkmapView
  transformer: InstanceType<MarkmapLib["Transformer"]>
}

let runtimePromise: Promise<MarkmapRuntime> | undefined

/**
 * loadMarkmap
 * 核心流程：并行加载转换器与视图库，只创建一个 Transformer，复用其 markdown-it 实例
 */
function loadMarkmap(): Promise<MarkmapRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([import("markmap-lib"), import("markmap-view")]).then(([lib, view]) => ({
      lib,
      view,
      transformer: new lib.Transformer(lib.builtInPlugins),
    }))
  }
  return runtimePromise
}

/** 分支配色：亮色主题偏深，暗色主题偏亮，保证两种背景下都有对比度 */
const LIGHT_PALETTE = ["#0b7285", "#c92a2a", "#5f3dc4", "#2b8a3e", "#e8590c", "#1098ad", "#a61e4d", "#495057"]
const DARK_PALETTE = ["#4dabf7", "#ff8787", "#b197fc", "#69db7c", "#ffa94d", "#66d9e8", "#f783ac", "#adb5bd"]

const SVG_NS = "http://www.w3.org/2000/svg"

/**
 * sanitizeTree
 * 参数：node 转换后的节点树
 * 核心流程：markmap 会把节点内容当 HTML 插入 foreignObject，递归清洗掉脚本与内联样式
 */
function sanitizeTree(node: PureNode): void {
  node.content = DOMPurify.sanitize(node.content, {
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style"],
  })
  node.children.forEach(sanitizeTree)
}

/**
 * renderMarkmap
 * 参数：target 图表容器；source Markdown 原文；theme 当前主题
 * 核心流程：Markdown → 节点树 → 清洗 → 创建 svg → Markmap 布局 → 适配视口；
 *           返回的销毁函数幂等，重复调用只释放一次
 */
export async function renderMarkmap(target: HTMLElement, source: string, theme: Theme): Promise<() => void> {
  const { view, transformer } = await loadMarkmap()
  const { root } = transformer.transform(source)
  sanitizeTree(root)

  const svg = document.createElementNS(SVG_NS, "svg")
  // 不能写 width="100%"：d3-zoom 读取 width.baseVal 时无法解析相对长度会抛错
  svg.setAttribute("class", "markmap-svg")
  target.replaceChildren(svg)

  // 关闭动画，避免消息流式结束后的首帧尺寸抖动影响虚拟列表测量
  const options = view.deriveOptions({
    color: themeMode(theme) === "dark" ? DARK_PALETTE : LIGHT_PALETTE,
    maxWidth: 320,
    spacingHorizontal: 64,
    spacingVertical: 6,
    duration: 0,
    initialExpandLevel: -1,
  })

  const map = new view.Markmap(svg, options)
  await map.setData(root)
  await map.fit()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    map.destroy()
    svg.remove()
  }
}

/**
 * markdown.tsx
 * 参数：MarkdownText { text 待渲染文本, class 附加样式类, streaming 是否仍在流式输出 }
 * 核心流程：marked（GFM + 换行）解析 → 自定义 renderer 用 highlight.js 高亮代码块 →
 *           调用链代码块/段落转 details 折叠树 → Mermaid / Markmap / ECharts / 梯形图（LAD）代码块转为待渲染占位 →
 *           DOMPurify 清洗（禁 style；链接统一 target=_blank + rel=noopener）→ innerHTML 输出 →
 *           挂载后异步把 Mermaid 占位渲染成 SVG（流式期间只展示源码）
 */
import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { Marked, type Tokens } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/common"
import katex from "katex"
import { copyText } from "../../lib/clipboard"
import { looksLikeCallChain, renderCallChainHtml } from "../../lib/call-chain"
import { renderEcharts } from "../../lib/echarts"
import { renderLad } from "../../lib/lad"
import { renderMarkmap } from "../../lib/markmap"
import { renderMermaid } from "../../lib/mermaid"
import { theme, type Theme } from "../../lib/ui-store"

/** 独立 marked 实例：GFM 表格/列表/删除线 + 单换行转 <br>，贴近聊天场景 */
const marked = new Marked({ gfm: true, breaks: true })

/**
 * escapeHtml
 * 参数：text 原始文本
 * 核心流程：转义 HTML 特殊字符，用于无语言代码块的兜底输出，防止 XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** 显式标记为调用链/树的代码块语言 */
const CALL_CHAIN_LANGS = new Set(["callchain", "call-chain", "callstack", "chain", "tree"])

/** 显式标记为 ECharts 图表的代码块语言 */
const ECHARTS_LANGS = new Set(["echarts", "echart", "chart"])

/**
 * renderMermaidPlaceholder
 * 参数：text Mermaid 源码
 * 核心流程：输出源码区 + 空图表容器；源码走 textContent 读取，避免属性转义问题
 */
function renderMermaidPlaceholder(text: string): string {
  return `<div class="mermaid-block" data-mermaid data-state="source" data-view="diagram"><div class="mermaid-bar"><span class="mermaid-label">Mermaid</span><button type="button" data-mermaid-action="source">Source</button></div><pre class="mermaid-source"><code class="language-mermaid">${escapeHtml(text)}</code></pre><div class="mermaid-diagram" role="img" aria-label="Mermaid diagram"></div></div>`
}

/**
 * renderEchartsPlaceholder
 * 参数：text ECharts option（JSON）
 * 核心流程：输出源码区 + 空图表容器；图表由 ECharts 在清洗后接管，
 *           容器高度由 CSS 固定，保证 init 时能量到真实尺寸
 */
function renderEchartsPlaceholder(text: string): string {
  return `<div class="echarts-block" data-echarts data-state="source" data-view="diagram"><div class="echarts-bar"><span class="echarts-label">ECharts</span><button type="button" data-echarts-action="source">Source</button></div><pre class="echarts-source"><code class="language-json">${escapeHtml(text)}</code></pre><div class="echarts-diagram" role="img" aria-label="ECharts chart"></div></div>`
}

/**
 * renderMarkmapPlaceholder
 * 参数：text Markdown 原文
 * 核心流程：输出源码区 + 空图表容器；图表由 Markmap 在清洗后接管
 */
function renderMarkmapPlaceholder(text: string): string {
  return `<div class="markmap-block" data-markmap data-state="source" data-view="diagram"><div class="markmap-bar"><span class="markmap-label">Mindmap</span><button type="button" data-markmap-action="source">Source</button></div><pre class="markmap-source"><code class="language-markdown">${escapeHtml(text)}</code></pre><div class="markmap-diagram"></div></div>`
}

/**
 * renderLadPlaceholder
 * 参数：text 梯形图 DSL 原文
 * 核心流程：输出源码区 + 空图表容器；图表由 schematex 在清洗后接管
 */
function renderLadPlaceholder(text: string): string {
  return `<div class="lad-block" data-lad data-state="source" data-view="diagram"><div class="lad-bar"><span class="lad-label">Ladder</span><button type="button" data-lad-action="source">Source</button></div><pre class="lad-source"><code class="language-lad">${escapeHtml(text)}</code></pre><div class="lad-diagram" role="img" aria-label="Ladder diagram"></div></div>`
}

/** 数学公式 token：text 为 TeX 源码，displayMode 控制行内/块级 */
interface MathToken extends Tokens.Generic {
  text: string
  displayMode: boolean
}

/** 行内 $...$ / $$...$$：结束符后不能紧跟字母数字，避免把价格区间误判成公式 */
const INLINE_MATH_RULE = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1(?=$|[^\w$])/
/** 块级 $$...$$：允许单行或跨行，前后可有空白 */
const BLOCK_DOLLAR_RULE = /^[ \t]*\$\$\n?([\s\S]*?)\n?\$\$(?:\n|$)/
/** 行内 \(...\) */
const INLINE_MATH_PAREN_RULE = /^\\\(([\s\S]*?)\\\)/
/** 块级 \[...\] */
const BLOCK_BRACKET_RULE = /^[ \t]*\\\[\n?([\s\S]*?)\n?\\\](?:\n|$)/
/** 行内 \[...\]：在段落中间时仍按块级公式渲染 */
const INLINE_MATH_BRACKET_RULE = /^\\\[([\s\S]*?)\\\]/

/**
 * mathPlaceholder
 * 参数：text TeX 源码；displayMode 是否块级；block 是否使用块级标签
 * 核心流程：输出空占位节点，TeX 用 encodeURIComponent 编码进 data 属性；
 *           KaTeX 在 DOMPurify 之后渲染，避免其内联样式被清洗掉
 */
function mathPlaceholder(text: string, displayMode: boolean, block: boolean): string {
  const tag = block ? "div" : "span"
  const className = displayMode ? "math-block" : "math-inline"
  return `<${tag} class="${className}" data-math="${encodeURIComponent(text.trim())}" data-display="${displayMode ? "1" : "0"}"></${tag}>`
}

/**
 * inlineMathStart
 * 参数：src marked 当前行资源
 * 核心流程：循环寻找可匹配的 $ / $$ 起点，跳过反斜杠转义，返回最早位置
 */
function inlineMathStart(src: string): number | undefined {
  let indexSrc = src
  while (indexSrc) {
    const index = indexSrc.indexOf("$")
    if (index === -1) return undefined
    const previous = index > 0 ? indexSrc[index - 1] : ""
    if (previous !== "\\" && previous !== "$" && indexSrc.substring(index).match(INLINE_MATH_RULE)) {
      return index
    }
    indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, "")
  }
  return undefined
}

/**
 * bracketInlineStart
 * 参数：src marked 当前行资源；open 起始符
 * 核心流程：查找未被反斜杠转义的 \( 或 \[ 位置
 */
function bracketInlineStart(src: string, open: string): number | undefined {
  let index = src.indexOf(open)
  while (index !== -1) {
    if (index === 0 || src[index - 1] !== "\\") return index
    index = src.indexOf(open, index + open.length)
  }
  return undefined
}

/**
 * blockMathStart
 * 参数：src marked 剩余文本（从第二个字符开始）
 * 核心流程：定位下一行行首的 $$ 或 \[，让段落在这里断开
 */
function blockMathStart(src: string): number | undefined {
  const match = /(?:^|\n)[ \t]*(?:\$\$|\\\[)/.exec(src)
  return match ? match.index : undefined
}

// 注册数学公式扩展：先块级、再行内；$ 规则同时覆盖单美元与双美元
marked.use({
  extensions: [
    {
      name: "mathBlockDollar",
      level: "block",
      start: blockMathStart,
      tokenizer(src: string) {
        const match = src.match(BLOCK_DOLLAR_RULE)
        if (!match) return
        return { type: "mathBlockDollar", raw: match[0], text: match[1], displayMode: true }
      },
      renderer(token: Tokens.Generic) {
        const math = token as MathToken
        return mathPlaceholder(math.text, true, true)
      },
    },
    {
      name: "mathBlockBracket",
      level: "block",
      start: blockMathStart,
      tokenizer(src: string) {
        const match = src.match(BLOCK_BRACKET_RULE)
        if (!match) return
        return { type: "mathBlockBracket", raw: match[0], text: match[1], displayMode: true }
      },
      renderer(token: Tokens.Generic) {
        const math = token as MathToken
        return mathPlaceholder(math.text, true, true)
      },
    },
    {
      name: "mathInlineDollar",
      level: "inline",
      start: inlineMathStart,
      tokenizer(src: string) {
        const match = src.match(INLINE_MATH_RULE)
        if (!match) return
        return {
          type: "mathInlineDollar",
          raw: match[0],
          text: match[2],
          displayMode: match[1].length === 2,
        }
      },
      renderer(token: Tokens.Generic) {
        const math = token as MathToken
        return mathPlaceholder(math.text, math.displayMode, false)
      },
    },
    {
      name: "mathInlineParen",
      level: "inline",
      start: (src: string) => bracketInlineStart(src, "\\("),
      tokenizer(src: string) {
        const match = src.match(INLINE_MATH_PAREN_RULE)
        if (!match) return
        return { type: "mathInlineParen", raw: match[0], text: match[1], displayMode: false }
      },
      renderer(token: Tokens.Generic) {
        const math = token as MathToken
        return mathPlaceholder(math.text, false, false)
      },
    },
    {
      name: "mathInlineBracket",
      level: "inline",
      start: (src: string) => bracketInlineStart(src, "\\["),
      tokenizer(src: string) {
        const match = src.match(INLINE_MATH_BRACKET_RULE)
        if (!match) return
        return { type: "mathInlineBracket", raw: match[0], text: match[1], displayMode: true }
      },
      renderer(token: Tokens.Generic) {
        const math = token as MathToken
        return mathPlaceholder(math.text, true, false)
      },
    },
  ],
})

/** 围栏语言标注里的起始行后缀：```go:98 或 ```go#L98（区间写法 -114 只取起始行） */
const FENCE_START_RULE = /^(.*?)(?:#l|:)(\d+)(?:-\d+)?$/

/**
 * parseFenceLang
 * 参数：lang 代码块围栏的 info 字符串，如 go:98
 * 核心流程：拆出语言与起始行号；带行号时返回 startLine，用于渲染独立的行号列
 */
function parseFenceLang(lang: string | undefined): { language: string; startLine?: number } {
  const info = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const match = info.match(FENCE_START_RULE)
  if (!match) return { language: info }
  const startLine = Number(match[2])
  return { language: match[1], startLine: startLine > 0 ? startLine : undefined }
}

/**
 * renderer.code / renderer.paragraph 覆盖
 * 参数：{ text 代码内容或段落原文, lang 语言标注 }
 * 核心流程：显式 callchain/tree 或无语言的树形代码块 → 折叠树；
 *           其余代码块有已注册语言则 highlight.js 高亮，否则转义原样输出；
 *           标注起始行时额外输出 select-none 的行号列，复制只取代码正文
 */
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const { language, startLine } = parseFenceLang(lang)
      if (language === "mermaid") return renderMermaidPlaceholder(text)
      if (language === "lad" || language === "ladder") return renderLadPlaceholder(text)
      if (language === "markmap" || language === "mindmap") return renderMarkmapPlaceholder(text)
      if (ECHARTS_LANGS.has(language)) return renderEchartsPlaceholder(text)
      const plainLanguage = !language || language === "text" || language === "plaintext"
      if (CALL_CHAIN_LANGS.has(language) || (plainLanguage && looksLikeCallChain(text))) {
        const html = renderCallChainHtml(text)
        if (html) return html
      }
      const body =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text)
      const langClass = language ? ` language-${language}` : ""
      const langAttr = language ? ` data-lang="${language}"` : ""
      // 外层 div 只负责定位复制按钮：代码块本身的折叠样式与按钮仍作用在 pre 上
      const copyButton = '<button type="button" class="md-code-copy" data-code-copy="1" aria-label="Copy code" title="Copy code">Copy</button>'
      if (startLine === undefined) {
        return `<div class="md-code-wrap" data-code-wrap><pre class="md-code"${langAttr}><code class="hljs${langClass}">${body}</code></pre>${copyButton}</div>`
      }
      // 行号列独立成列（aria-hidden + CSS user-select:none），复制代码时不会带上行号
      const lineCount = text.split("\n").length
      const gutter = Array.from({ length: lineCount }, (_, index) => startLine + index).join("\n")
      return `<div class="md-code-wrap" data-code-wrap><pre class="md-code md-code-numbered"${langAttr} data-start="${startLine}"><span class="md-code-gutter" aria-hidden="true">${gutter}</span><code class="hljs${langClass}">${body}</code></pre>${copyButton}</div>`
    },
    paragraph({ text, tokens }: Tokens.Paragraph): string {
      // 未包在代码块里的纯文本调用链同样支持折叠
      if (looksLikeCallChain(text)) {
        const html = renderCallChainHtml(text)
        if (html) return html
      }
      return `<p>${this.parser.parseInline(tokens)}</p>`
    },
  },
})

// 清洗后给所有链接补 target/rel：外链新窗口打开且不带 opener
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
  }
})

/**
 * renderMarkdown
 * 参数：text markdown 源文本
 * 核心流程：marked 解析为 HTML → DOMPurify 清洗（禁 style 属性/标签，杜绝内联样式与脚本）
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string
  return DOMPurify.sanitize(raw, {
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style"],
    ADD_TAGS: ["details", "summary"],
    ADD_ATTR: ["open"],
  })
}

/**
 * handleMarkdownClick
 * 参数：e 冒泡到 md-body 的点击事件
 * 核心流程：命中代码块按钮 → 在 10 行预览与展开全文之间切换；
 *           命中调用链按钮 → 批量展开/折叠同组 details；
 *           命中 Mermaid 源码按钮 → 在图表与源码之间切换
 */
function handleMarkdownClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null

  const copyButton = target?.closest<HTMLElement>("[data-code-copy]")
  if (copyButton) {
    const pre = copyButton.closest<HTMLElement>("[data-code-wrap]")?.querySelector("pre.md-code")
    if (!pre) return
    // 折叠只影响显示高度，textContent 仍是完整代码
    void copyText(pre.textContent ?? "").then((ok) => {
      if (!ok) return
      copyButton.textContent = "Copied"
      window.setTimeout(() => {
        copyButton.textContent = "Copy"
      }, 1500)
    })
    return
  }

  const codeToggle = target?.closest<HTMLElement>("[data-code-toggle]")
  if (codeToggle) {
    const pre = codeToggle.previousElementSibling
    if (pre instanceof HTMLPreElement) {
      const expanded = pre.dataset.codeClamp === "expanded"
      pre.dataset.codeClamp = expanded ? "collapsed" : "expanded"
      codeToggle.setAttribute("aria-expanded", String(!expanded))
      codeToggle.textContent = expanded
        ? `Show more · +${hiddenCodeLines(pre.scrollHeight)} lines`
        : "Show less"
    }
    return
  }

  const mermaidAction = target?.closest<HTMLElement>("[data-mermaid-action]")
  if (mermaidAction) {
    const block = mermaidAction.closest<HTMLElement>("[data-mermaid]")
    if (!block || block.dataset.state !== "ready") return
    const showingSource = block.dataset.view === "source"
    block.dataset.view = showingSource ? "diagram" : "source"
    mermaidAction.textContent = showingSource ? "Source" : "Diagram"
    return
  }

  const ladAction = target?.closest<HTMLElement>("[data-lad-action]")
  if (ladAction) {
    const block = ladAction.closest<HTMLElement>("[data-lad]")
    if (!block || block.dataset.state !== "ready") return
    const showingSource = block.dataset.view === "source"
    block.dataset.view = showingSource ? "diagram" : "source"
    ladAction.textContent = showingSource ? "Source" : "Diagram"
    return
  }

  const markmapAction = target?.closest<HTMLElement>("[data-markmap-action]")
  if (markmapAction) {
    const block = markmapAction.closest<HTMLElement>("[data-markmap]")
    if (!block || block.dataset.state !== "ready") return
    const showingSource = block.dataset.view === "source"
    block.dataset.view = showingSource ? "diagram" : "source"
    markmapAction.textContent = showingSource ? "Source" : "Diagram"
    return
  }

  const echartsAction = target?.closest<HTMLElement>("[data-echarts-action]")
  if (echartsAction) {
    const block = echartsAction.closest<HTMLElement>("[data-echarts]")
    if (!block || block.dataset.state !== "ready") return
    const showingSource = block.dataset.view === "source"
    block.dataset.view = showingSource ? "diagram" : "source"
    echartsAction.textContent = showingSource ? "Source" : "Diagram"
    return
  }

  const action = target?.closest<HTMLElement>("[data-callchain-action]")
  if (!action) return
  const root = action.closest<HTMLElement>("[data-callchain]")
  if (!root) return
  const open = action.dataset.callchainAction === "expand"
  root.querySelectorAll("details").forEach((item) => {
    if (item instanceof HTMLDetailsElement) item.open = open
  })
}

/** 正文代码块预览行数与行高（12px * 1.55），与 index.css 的 max-height 保持一致 */
const CODE_PREVIEW_LINES = 10
const CODE_LINE_HEIGHT = 18.6
const CODE_PREVIEW_HEIGHT = 206

/**
 * hiddenCodeLines
 * 参数：height 代码块完整高度
 * 核心流程：扣掉上下 padding 后按行高估算被裁掉的行数，至少为 1
 */
function hiddenCodeLines(height: number): number {
  return Math.max(1, Math.ceil((height - 20) / CODE_LINE_HEIGHT) - CODE_PREVIEW_LINES)
}

/**
 * applyCodeClamps
 * 参数：root Markdown 根节点；streaming 是否仍在流式输出
 * 核心流程：流式期间保持全文避免每帧跳动；完成后对超过 10 行的代码块
 *          标记 collapsed，并在其后插入 Show more 按钮
 */
function applyCodeClamps(root: HTMLElement, streaming: boolean) {
  root.querySelectorAll<HTMLButtonElement>("[data-code-toggle]").forEach((button) => button.remove())
  root.querySelectorAll<HTMLPreElement>("pre.md-code").forEach((pre) => {
    pre.removeAttribute("data-code-clamp")
    if (streaming) return
    const full = pre.scrollHeight
    if (full <= CODE_PREVIEW_HEIGHT + 2) return
    pre.dataset.codeClamp = "collapsed"
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.dataset.codeToggle = "1"
    toggle.className = "md-code-toggle"
    toggle.setAttribute("aria-expanded", "false")
    toggle.textContent = `Show more · +${hiddenCodeLines(full)} lines`
    pre.insertAdjacentElement("afterend", toggle)
  })
}

/**
 * resetMermaidBlocks
 * 参数：root Markdown 根节点
 * 核心流程：文本或主题变化后清空旧 SVG，恢复源码态与按钮文案，避免展示过期图表
 */
function resetMermaidBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-mermaid]").forEach((block) => {
    block.dataset.state = "source"
    block.dataset.view = "diagram"
    const toggle = block.querySelector<HTMLButtonElement>("[data-mermaid-action]")
    if (toggle) toggle.textContent = "Source"
    const diagram = block.querySelector<HTMLElement>(".mermaid-diagram")
    if (diagram) diagram.innerHTML = ""
  })
}

/**
 * resetLadBlocks
 * 参数：root Markdown 根节点
 * 核心流程：文本或主题变化后清空旧 SVG，恢复源码态与按钮文案
 */
function resetLadBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-lad]").forEach((block) => {
    block.dataset.state = "source"
    block.dataset.view = "diagram"
    const toggle = block.querySelector<HTMLButtonElement>("[data-lad-action]")
    if (toggle) toggle.textContent = "Source"
    const diagram = block.querySelector<HTMLElement>(".lad-diagram")
    if (diagram) diagram.innerHTML = ""
  })
}

/**
 * renderMathBlocks
 * 参数：root Markdown 根节点
 * 核心流程：读取占位节点里的 TeX 源码 → KaTeX 同步渲染；
 *           失败回退为等宽源码并标记 error；已渲染节点在主题变化时跳过
 */
function renderMathBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-math]").forEach((node) => {
    if (node.dataset.mathState === "ready") return
    const encoded = node.dataset.math
    if (!encoded) return
    let source = ""
    try {
      source = decodeURIComponent(encoded)
    } catch {
      return
    }
    try {
      katex.render(source, node, {
        displayMode: node.dataset.display === "1",
        throwOnError: true,
        trust: false,
        strict: "ignore",
      })
      node.dataset.mathState = "ready"
    } catch {
      node.textContent = source
      node.dataset.mathState = "error"
    }
  })
}

/**
 * MarkdownText
 * 参数：props.text 文本；props.class 附加样式；props.streaming 是否仍在流式输出
 * 核心流程：createMemo 缓存解析结果并注入 md-body；
 *           挂载后同步渲染 KaTeX 公式、按序把 Mermaid / Markmap / ECharts / 梯形图占位渲染成图形（流式期间仅展示源码）；
 *           事件委托处理调用链展开/折叠与 Mermaid 源码切换
 */
export function MarkdownText(props: { text: string; class?: string; streaming?: boolean }) {
  const html = createMemo(() => renderMarkdown(props.text))
  let rootRef: HTMLDivElement | undefined
  let renderSeq = 0
  /** 当前挂载的 Markmap 销毁函数：文本或主题变化时统一释放 */
  const markmapCleanups = new Set<() => void>()
  /** 当前挂载的 ECharts 销毁函数：同上，需断开 ResizeObserver 并 dispose 画布 */
  const echartsCleanups = new Set<() => void>()

  /**
   * destroyMarkmaps
   * 核心流程：逐个调用销毁函数，清空集合；Markmap 内部持有 ResizeObserver 与 d3 缩放监听
   */
  function destroyMarkmaps() {
    markmapCleanups.forEach((dispose) => dispose())
    markmapCleanups.clear()
  }

  /**
   * destroyEcharts
   * 核心流程：逐个调用销毁函数，清空集合；ECharts 实例持有 ResizeObserver 与画布，必须显式释放
   */
  function destroyEcharts() {
    echartsCleanups.forEach((dispose) => dispose())
    echartsCleanups.clear()
  }

  /**
   * resetMarkmapBlocks
   * 参数：root Markdown 根节点
   * 核心流程：先释放旧实例，再把每个块恢复源码态与按钮文案，清空图表容器
   */
  function resetMarkmapBlocks(root: HTMLElement) {
    destroyMarkmaps()
    root.querySelectorAll<HTMLElement>("[data-markmap]").forEach((block) => {
      block.dataset.state = "source"
      block.dataset.view = "diagram"
      const toggle = block.querySelector<HTMLButtonElement>("[data-markmap-action]")
      if (toggle) toggle.textContent = "Source"
      const diagram = block.querySelector<HTMLElement>(".markmap-diagram")
      if (diagram) diagram.replaceChildren()
    })
  }

  /**
   * resetEchartsBlocks
   * 参数：root Markdown 根节点
   * 核心流程：先 dispose 旧实例，再把每个块恢复源码态与按钮文案，清空图表容器
   */
  function resetEchartsBlocks(root: HTMLElement) {
    destroyEcharts()
    root.querySelectorAll<HTMLElement>("[data-echarts]").forEach((block) => {
      block.dataset.state = "source"
      block.dataset.view = "diagram"
      const toggle = block.querySelector<HTMLButtonElement>("[data-echarts-action]")
      if (toggle) toggle.textContent = "Source"
      const diagram = block.querySelector<HTMLElement>(".echarts-diagram")
      if (diagram) diagram.replaceChildren()
    })
  }

  /**
   * renderMermaidBlocks
   * 参数：root 容器；seq 本次渲染序号；currentTheme 当前主题
   * 核心流程：串行渲染每个占位，成功后写入 SVG 并标记 ready；
   *           失败标记 error 保留源码；序号变化或节点卸载时丢弃过期结果
   */
  async function renderMermaidBlocks(root: HTMLElement, seq: number, currentTheme: Theme) {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")]
    for (const block of blocks) {
      if (seq !== renderSeq || !block.isConnected) return
      const source = block.querySelector<HTMLElement>(".mermaid-source code")?.textContent ?? ""
      const diagram = block.querySelector<HTMLElement>(".mermaid-diagram")
      if (!source.trim() || !diagram) {
        block.dataset.state = "error"
        continue
      }

      block.dataset.state = "rendering"
      try {
        const result = await renderMermaid(source, currentTheme)
        if (seq !== renderSeq || !block.isConnected) return
        diagram.innerHTML = result.svg
        result.bindFunctions?.(diagram)
        diagram.querySelectorAll("a").forEach((link) => {
          link.setAttribute("target", "_blank")
          link.setAttribute("rel", "noopener noreferrer")
        })
        block.dataset.state = "ready"
      } catch {
        if (seq !== renderSeq) return
        block.dataset.state = "error"
      }
    }
  }

  /**
   * renderMarkmapBlocks
   * 参数：root 容器；seq 本次渲染序号；currentTheme 当前主题
   * 核心流程：串行把每个占位交给 Markmap 布局，成功后标记 ready；
   *           序号失效时销毁刚建好的实例，避免残留缩放监听
   */
  async function renderMarkmapBlocks(root: HTMLElement, seq: number, currentTheme: Theme) {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-markmap]")]
    for (const block of blocks) {
      if (seq !== renderSeq || !block.isConnected) return
      const source = block.querySelector<HTMLElement>(".markmap-source code")?.textContent ?? ""
      const diagram = block.querySelector<HTMLElement>(".markmap-diagram")
      if (!source.trim() || !diagram) {
        block.dataset.state = "error"
        continue
      }

      block.dataset.state = "rendering"
      try {
        const dispose = await renderMarkmap(diagram, source, currentTheme)
        if (seq !== renderSeq || !block.isConnected) {
          dispose()
          return
        }
        markmapCleanups.add(dispose)
        block.dataset.state = "ready"
      } catch {
        if (seq !== renderSeq) return
        block.dataset.state = "error"
      }
    }
  }

  /**
   * renderLadBlocks
   * 参数：root 容器；seq 本次渲染序号；currentTheme 当前主题
   * 核心流程：串行把每个梯形图占位渲染成 SVG，成功后标记 ready；
   *           语法错误标记 error 保留源码；序号变化或节点卸载时丢弃过期结果
   */
  async function renderLadBlocks(root: HTMLElement, seq: number, currentTheme: Theme) {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-lad]")]
    for (const block of blocks) {
      if (seq !== renderSeq || !block.isConnected) return
      const source = block.querySelector<HTMLElement>(".lad-source code")?.textContent ?? ""
      const diagram = block.querySelector<HTMLElement>(".lad-diagram")
      if (!source.trim() || !diagram) {
        block.dataset.state = "error"
        continue
      }

      block.dataset.state = "rendering"
      try {
        const svg = await renderLad(source, currentTheme)
        if (seq !== renderSeq || !block.isConnected) return
        diagram.innerHTML = svg
        block.dataset.state = "ready"
      } catch {
        if (seq !== renderSeq) return
        block.dataset.state = "error"
      }
    }
  }

  /**
   * renderEchartsBlocks
   * 参数：root 容器；seq 本次渲染序号；currentTheme 当前主题
   * 核心流程：串行把每个占位交给 ECharts，成功后标记 ready；
   *           序号失效时先销毁刚建好的实例，避免过期画布与监听残留
   */
  async function renderEchartsBlocks(root: HTMLElement, seq: number, currentTheme: Theme) {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-echarts]")]
    for (const block of blocks) {
      if (seq !== renderSeq || !block.isConnected) return
      const source = block.querySelector<HTMLElement>(".echarts-source code")?.textContent ?? ""
      const diagram = block.querySelector<HTMLElement>(".echarts-diagram")
      if (!source.trim() || !diagram) {
        block.dataset.state = "error"
        continue
      }

      block.dataset.state = "rendering"
      try {
        const dispose = await renderEcharts(diagram, source, currentTheme)
        if (seq !== renderSeq || !block.isConnected) {
          dispose()
          return
        }
        echartsCleanups.add(dispose)
        block.dataset.state = "ready"
      } catch {
        if (seq !== renderSeq) return
        block.dataset.state = "error"
      }
    }
  }

  createEffect(
    on(
      [html, () => props.streaming === true, theme],
      () => {
        const root = rootRef
        if (!root) return
        const seq = ++renderSeq
        const streaming = props.streaming === true
        const currentTheme = theme()
        // 等待 Solid 把最新 innerHTML 写入 DOM 后再查找占位
        queueMicrotask(() => {
          if (seq !== renderSeq || !root.isConnected) return
          resetMermaidBlocks(root)
          resetMarkmapBlocks(root)
          resetEchartsBlocks(root)
          resetLadBlocks(root)
          renderMathBlocks(root)
          applyCodeClamps(root, streaming)
          if (streaming) return
          void renderMermaidBlocks(root, seq, currentTheme)
          void renderMarkmapBlocks(root, seq, currentTheme)
          void renderEchartsBlocks(root, seq, currentTheme)
          void renderLadBlocks(root, seq, currentTheme)
        })
      },
    ),
  )

  onCleanup(() => {
    renderSeq++
    destroyMarkmaps()
    destroyEcharts()
  })

  return (
    <div
      ref={rootRef}
      class={"md-body" + (props.class ? ` ${props.class}` : "")}
      innerHTML={html()}
      onClick={handleMarkdownClick}
    />
  )
}

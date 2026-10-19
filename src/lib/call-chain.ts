/**
 * call-chain.ts
 * 参数：text 缩进/树形符号形式的调用链文本
 * 核心流程：按连接符列或行首缩进解析节点层级 → 递归生成原生 details/summary
 *           的折叠 HTML；解析失败时由调用方回退为普通代码块
 */

export type CallChainNode = {
  label: string
  children: CallChainNode[]
}

type StackEntry = {
  column: number
  node: CallChainNode
}

/** 树形连接符：允许前缀包含竖线与空格，兼容 ├─ / ├── / └─ */
const CONNECTOR = /^([\s│]*)(?:[├└]─+)\s*/
/** 末尾的 文件:行号，用于单独着色 */
const LOCATION = /^(.*?)(\s+[\w./\\-]+\.\w+:\d+(?:-\d+)?)$/

/**
 * escapeHtml
 * 参数：text 原始文本
 * 核心流程：转义 HTML 特殊字符，节点标签不参与 Markdown 解析
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * parseCallChain
 * 参数：text 原始调用链文本
 * 核心流程：逐行计算连接符列或缩进列 → 维护栈找到父节点 → 生成森林；
 *           同级列或更浅列先出栈，因此分支与多层嵌套都能正确归位
 */
export function parseCallChain(text: string): CallChainNode[] {
  const roots: CallChainNode[] = []
  const stack: StackEntry[] = []

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue

    const connector = CONNECTOR.exec(raw)
    const leading = /^[ \t]*/.exec(raw)?.[0] ?? ""
    // 树形行用连接符所在列定位；普通缩进行按空格数列定位（Tab 视为 4 空格）
    const column = connector ? (connector[1] ?? "").length : leading.replace(/\t/g, "    ").length
    const label = (connector ? raw.slice(connector[0].length) : raw.slice(leading.length)).trim()
    if (!label) continue

    const node: CallChainNode = { label, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].column >= column) stack.pop()

    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)

    stack.push({ column, node })
  }

  return roots
}

/**
 * looksLikeCallChain
 * 参数：text 待判断文本
 * 核心流程：至少 3 行、至少 2 个连接符，且连接符行占比过半才视为调用链，
 *           避免把普通段落或少量符号误判成树
 */
export function looksLikeCallChain(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 3) return false

  const connectorLines = lines.filter((line) => /^[\s│]*[├└]─/.test(line)).length
  return connectorLines >= 2 && connectorLines / lines.length >= 0.5
}

/**
 * labelHtml
 * 参数：label 节点标签
 * 核心流程：拆出末尾文件:行号 → 分别转义 → 行号使用弱化样式，便于扫读
 */
function labelHtml(label: string): string {
  const match = LOCATION.exec(label)
  if (!match) return `<span class="call-chain-label">${escapeHtml(label)}</span>`
  return `<span class="call-chain-label">${escapeHtml(match[1])}<span class="call-chain-loc">${escapeHtml(match[2].trim())}</span></span>`
}

/**
 * renderNodes
 * 参数：nodes 节点列表；depth 当前深度
 * 核心流程：叶子输出 div；有子节点输出 details（前两层默认展开）并递归子树
 */
function renderNodes(nodes: CallChainNode[], depth: number): string {
  const items = nodes.map((node) => {
    const summary = `<summary class="call-chain-summary">${labelHtml(node.label)}</summary>`
    if (node.children.length === 0) {
      return `<div class="call-chain-leaf" data-depth="${depth}">${labelHtml(node.label)}</div>`
    }
    const open = depth < 2 ? " open" : ""
    return `<details class="call-chain-node" data-depth="${depth}"${open}>${summary}${renderNodes(node.children, depth + 1)}</details>`
  })
  return `<div class="call-chain-children">${items.join("")}</div>`
}

/**
 * renderCallChainHtml
 * 参数：text 原始调用链文本
 * 核心流程：解析成节点树 → 生成带工具栏的折叠树 HTML；无有效节点时返回空串
 */
export function renderCallChainHtml(text: string): string {
  const nodes = parseCallChain(text)
  if (nodes.length === 0) return ""
  return `<div class="call-chain" data-callchain>
<div class="call-chain-bar">
<span class="call-chain-title">调用链</span>
<span class="call-chain-actions">
<button type="button" data-callchain-action="expand">展开全部</button>
<button type="button" data-callchain-action="collapse">折叠全部</button>
</span>
</div>
<div class="call-chain-tree">${renderNodes(nodes, 0)}</div>
</div>`
}

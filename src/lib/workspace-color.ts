/**
 * workspace-color.ts
 * 参数：无
 * 核心流程：把工作区项目路径映射到稳定的低饱和色，
 *           供顶栏标签与溢出菜单区分不同工作区。
 */

/** 8 色低饱和调色板：色相分散，深浅主题下都能辨识 */
const PALETTE = [
  "#e5484d",
  "#f76b15",
  "#f5b944",
  "#46a758",
  "#12a594",
  "#3e8fdb",
  "#7c5cff",
  "#d6409f",
]

/**
 * hashPath
 * 参数：key 工作区标识（优先项目路径）
 * 核心流程：FNV-1a 32 位哈希后做一次雪崩混合（murmur3 fmix32）——
 *           FNV-1a 低位扩散差，相近路径直接取模容易撞色
 */
function hashPath(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 2246822507)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 3266489909)
  hash ^= hash >>> 16
  return hash >>> 0
}

/** 工作区配色：solid 用于色条/圆点，tint 用于激活标签背景 */
export interface WorkspaceColor {
  solid: string
  tint: string
}

/**
 * workspaceColor
 * 参数：key 工作区标识（项目路径优先，缺失时退化为 workspace id）
 * 核心流程：哈希取模选色 → 生成激活态 tint（与 bg-raised 混合，避免压过选中态）
 */
export function workspaceColor(key?: string): WorkspaceColor | undefined {
  if (!key) return undefined
  const solid = PALETTE[hashPath(key) % PALETTE.length]
  return { solid, tint: `color-mix(in srgb, ${solid} 14%, var(--bg-raised))` }
}

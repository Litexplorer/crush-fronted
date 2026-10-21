/**
 * mentions.ts
 * 核心流程：# 引用候选层 ——
 *           listSkills + listMcp 合并成统一候选（skill 在前、MCP 在后），
 *           过滤 disabled 的 MCP，再按 query 做名称/描述过滤与前缀优先排序
 */
import { listMcp, listSkills, type McpState, type SkillInfo } from "./diagnostics"

/** # 引用候选：skill 携带 skill_id，MCP 只带服务名 */
export type MentionItem =
  | { kind: "skill"; id: string; name: string; description: string }
  | { kind: "mcp"; name: string; toolCount: number }

/** 候选数据源：两个接口互不依赖，由调用方并行加载后合并 */
export interface MentionSources {
  skills: SkillInfo[]
  mcp: McpState[]
}

/**
 * loadMentionSources
 * 参数：wsId workspace ID
 * 核心流程：并行拉取 skills 与 mcp states，任一失败直接抛出供浮层展示错误
 */
export async function loadMentionSources(wsId: string): Promise<MentionSources> {
  const [skills, mcp] = await Promise.all([listSkills(wsId), listMcp(wsId)])
  return { skills, mcp }
}

/**
 * buildMentionItems
 * 参数：sources 候选数据源
 * 核心流程：skills 转候选并按名称排序 → MCP 过滤 disabled 后按名称排序 →
 *           拼接成 skill 优先的单一列表（保持后端返回的可见性，不做去重）
 */
export function buildMentionItems(sources: MentionSources): MentionItem[] {
  const skillItems: MentionItem[] = [...sources.skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      kind: "skill",
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }))

  const mcpItems: MentionItem[] = sources.mcp
    .filter((server) => server.state !== "disabled")
    .map((server): MentionItem => ({
      kind: "mcp",
      name: server.name,
      toolCount: server.tool_count ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return [...skillItems, ...mcpItems]
}

/**
 * filterMentionItems
 * 参数：items 候选列表；query 用户搜索词
 * 核心流程：空查询原样返回 → 按 完全匹配 > 前缀匹配 > 名称包含 > 描述包含 分档 →
 *           同档保持原有顺序（skill 在前、字母序），避免搜索时类型乱跳
 */
export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items

  const scored: { item: MentionItem; tier: number }[] = []
  for (const item of items) {
    const name = item.name.toLowerCase()
    const description = item.kind === "skill" ? item.description.toLowerCase() : ""
    if (name === q) scored.push({ item, tier: 0 })
    else if (name.startsWith(q)) scored.push({ item, tier: 1 })
    else if (name.includes(q)) scored.push({ item, tier: 2 })
    else if (description.includes(q)) scored.push({ item, tier: 3 })
  }
  // 分档排序：Array#sort 是稳定排序，同档保留 buildMentionItems 的顺序
  return scored.sort((a, b) => a.tier - b.tier).map((entry) => entry.item)
}

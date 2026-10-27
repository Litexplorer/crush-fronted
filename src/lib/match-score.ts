/**
 * match-score.ts
 * 核心流程：@ 文件提及的相关度排序 ——
 *           先按匹配形态分档（完整匹配 > 前缀 > 子串 > 目录段前缀 > 路径子串），
 *           档内再用「命中位置 → 覆盖率 → 路径深度 → 目录优先」的元组字典序破平，
 *           同分最后按路径字典序收尾，保证键盘上下选择时顺序稳定不抖动；
 *           查询含 "/" 视为「用户已给出路径」，改用整条路径打分，不再按文件名排序
 */

/** 打分所需的最小条目形状：与 proto.FileEntry 兼容，测试里可直接构造 */
export interface PathTarget {
  name: string
  path: string
  is_dir: boolean
}

/** 一条候选的匹配质量；数字越小/越大按字段含义见 compareMatch */
export interface PathMatch {
  /** 匹配形态档位：越小越相关 */
  tier: number
  /** 命中起点下标：越靠前越相关 */
  pos: number
  /** 命中覆盖率（查询长度 / 被命中对象长度）：越大越相关 */
  coverage: number
  /** 路径段数：越浅越相关 */
  depth: number
  /** 目录记 0、文件记 1：同分时目录优先，保留「输入目录名后下钻」的习惯 */
  isFile: number
}

/** 路径模式（查询含 "/"）的四档 */
const PATH_TIER_EXACT = 0
const PATH_TIER_PREFIX = 1
const PATH_TIER_SEGMENT = 2
const PATH_TIER_INCLUDE = 3

/** 文件名模式的六档 */
const NAME_TIER_EXACT_CASE = 0
const NAME_TIER_EXACT = 1
const NAME_TIER_PREFIX = 2
const NAME_TIER_INCLUDE = 3
const DIR_TIER_PREFIX = 4
const PATH_TIER_ANY = 5

/**
 * normalizeQuery
 * 参数：query 原始输入
 * 核心流程：去首尾空白、去掉开头的 "./" 或 "/"、统一小写；
 *           大小写敏感只对「文件名完全相等」的 0 档单独判断，其余一律不区分大小写
 */
function normalizeQuery(query: string): string {
  return query.trim().replace(/^\.?\//, "").toLowerCase()
}

/**
 * scorePathMatch
 * 参数：target 候选条目（name/path/is_dir）；query 搜索词
 * 核心流程：空查询或完全不命中的返回 undefined；
 *           含 "/" 走路径模式（全等 > 前缀 > 段边界子串 > 任意子串）；
 *           否则优先按文件名分档（大小写一致全等 > 忽略大小写全等 > 前缀 > 子串），
 *           文件名没命中再看目录段前缀、整条路径子串
 */
export function scorePathMatch(target: PathTarget, query: string): PathMatch | undefined {
  const q = normalizeQuery(query)
  if (!q) return undefined
  const path = target.path === "." ? "" : target.path
  const lowerPath = path.toLowerCase()
  const depth = lowerPath ? lowerPath.split("/").length : 0
  const isFile = target.is_dir ? 0 : 1

  // 路径模式：用户已经在给路径，文件名命中不再作为优先条件
  if (q.includes("/")) {
    if (!lowerPath) return undefined
    const pos = lowerPath.indexOf(q)
    if (pos < 0) return undefined
    const tier =
      lowerPath === q
        ? PATH_TIER_EXACT
        : pos === 0
          ? PATH_TIER_PREFIX
          : lowerPath[pos - 1] === "/"
            ? PATH_TIER_SEGMENT
            : PATH_TIER_INCLUDE
    return { tier, pos, coverage: q.length / lowerPath.length, depth, isFile }
  }

  const name = target.name.toLowerCase()
  const coverage = q.length / Math.max(name.length, 1)
  if (name === q) {
    // 大小写完全一致再压一档：输入 view 时 view 比 View 更靠前
    const tier = target.name === query.trim() ? NAME_TIER_EXACT_CASE : NAME_TIER_EXACT
    return { tier, pos: 0, coverage, depth, isFile }
  }
  if (name.startsWith(q)) return { tier: NAME_TIER_PREFIX, pos: 0, coverage, depth, isFile }
  const hitInName = name.indexOf(q)
  if (hitInName >= 0) return { tier: NAME_TIER_INCLUDE, pos: hitInName, coverage, depth, isFile }

  // 文件名没命中：先看某一级目录是否以查询开头（如 view → src/views/...）
  const segments = lowerPath.split("/")
  let offset = 0
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    if (segment.startsWith(q)) {
      return {
        tier: DIR_TIER_PREFIX,
        pos: offset,
        coverage: q.length / Math.max(segment.length, 1),
        depth,
        isFile,
      }
    }
    offset += segment.length + 1
  }

  // 最后兜底：路径任意位置包含查询（命中的只能是目录部分，文件名已在上面判断过）
  const hitInPath = lowerPath.indexOf(q)
  if (hitInPath >= 0) {
    return { tier: PATH_TIER_ANY, pos: hitInPath, coverage: q.length / Math.max(lowerPath.length, 1), depth, isFile }
  }
  return undefined
}

/**
 * compareMatch
 * 参数：a / b 两条匹配质量
 * 核心流程：按「档位 → 命中位置 → 覆盖率降序 → 深度升序 → 目录优先」逐级比较，
 *           全相等返回 0，交给调用方用路径字典序收尾
 */
export function compareMatch(a: PathMatch, b: PathMatch): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.pos !== b.pos) return a.pos - b.pos
  if (a.coverage !== b.coverage) return b.coverage - a.coverage
  if (a.depth !== b.depth) return a.depth - b.depth
  return a.isFile - b.isFile
}

/**
 * rankPathMatches
 * 参数：items 候选条目；query 搜索词
 * 核心流程：逐条打分（不命中的直接剔除）→ 按 compareMatch 排序 →
 *           同分用路径字典序收尾（不用 localeCompare：上万条候选时过慢且结果依赖 locale）；
 *           空查询原样返回，浏览顺序交给调用方
 */
export function rankPathMatches<T extends PathTarget>(items: T[], query: string): T[] {
  if (!query.trim()) return [...items]
  const scored: { item: T; match: PathMatch }[] = []
  for (const item of items) {
    const match = scorePathMatch(item, query)
    if (match) scored.push({ item, match })
  }
  scored.sort((a, b) => {
    const byMatch = compareMatch(a.match, b.match)
    if (byMatch !== 0) return byMatch
    if (a.item.path === b.item.path) return 0
    return a.item.path < b.item.path ? -1 : 1
  })
  return scored.map((entry) => entry.item)
}

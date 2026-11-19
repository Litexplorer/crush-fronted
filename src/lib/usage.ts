/**
 * usage.ts
 * 核心流程：用量展示的纯函数 ——
 *           approxTokens  按 ASCII 4 字符 1 token、非 ASCII 1 字符 1 token 估算
 *           tokenRate     由 finish 分片的 output_tokens/generation_ms 计算吐字速率
 *           countChars    按 Unicode 码点计字符数（emoji 记 1）
 *           formatTokens  1.2K / 34K / 1.2M 紧凑格式
 *           formatChars   字符数同款紧凑格式
 *           formatCachePercent 缓存命中率按接近 100% 的程度逐级放大精度
 */

/**
 * approxTokens
 * 参数：text 待估算文本
 * 核心流程：分别统计 ASCII 与非 ASCII 字符数，与后端 usage_fallback 同口径
 */
export function approxTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let nonASCII = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) {
      ascii++
    } else {
      nonASCII++
    }
  }
  return Math.floor((ascii + 3) / 4) + nonASCII
}

/**
 * tokenRate
 * 参数：outputTokens 本回合累计输出 token；generationMs 真实吐字耗时（毫秒）
 * 核心流程：样本不足 0.1 秒或 token 为 0 时视为无记账，返回 undefined；
 *           否则返回 tokens/秒
 */
export function tokenRate(outputTokens?: number, generationMs?: number): number | undefined {
  if (!outputTokens || !generationMs || generationMs < 100) return undefined
  return outputTokens / (generationMs / 1000)
}

/**
 * countChars
 * 参数：text 待统计文本
 * 核心流程：按码点迭代计数，代理对（emoji 等）记 1，与 String.length 的 UTF-16 口径区分
 */
export function countChars(text: string): number {
  if (!text) return 0
  let count = 0
  for (const _ch of text) count++
  return count
}

/**
 * compactCount
 * 参数：n 计数值；millionDecimals 百万级保留的小数位（默认 1）
 * 核心流程：小于 1000 原样；千级保留一位小数（整数省略）；百万级按传入位数保留，末尾 0 省略
 */
function compactCount(n: number, millionDecimals = 1): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) {
    const value = n / 1000
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}K`
  }
  const value = n / 1_000_000
  if (value >= 100) return `${Math.round(value)}M`
  return `${value.toFixed(millionDecimals).replace(/\.?0+$/, "")}M`
}

/**
 * formatTokens
 * 参数：n token 数
 * 核心流程：委托 compactCount，输出 1.2K / 34K / 1.2M
 */
export function formatTokens(n: number): string {
  return compactCount(n)
}

/**
 * formatChars
 * 参数：n 字符数
 * 核心流程：与 formatTokens 同款紧凑格式，百万级保留两位小数（1.23M）以便看出增长
 */
export function formatChars(n: number): string {
  return compactCount(n, 2)
}

/**
 * cacheHitRate
 * 参数：hit 命中缓存的 prompt token 累计；miss 未命中缓存的 prompt token 累计
 * 核心流程：按 DeepSeek 口径 hit / (hit + miss) 返回百分比；分母为 0 表示
 *           没有可统计的样本（未上报或全部为估算值），返回 undefined
 */
export function cacheHitRate(hit?: number, miss?: number): number | undefined {
  const total = (hit ?? 0) + (miss ?? 0)
  if (total <= 0) return undefined
  return ((hit ?? 0) / total) * 100
}

/**
 * formatCachePercent
 * 参数：value 0-100 的缓存命中率
 * 核心流程：越接近 100% 越放大精度 —— 基准两位小数，≥99.9 三位、≥99.99 四位，以此类推（上限六位）；
 *           正好 100% 直接输出 100%，不然会被 toFixed 抹成看不出差距的 100.00%
 */
export function formatCachePercent(value: number): string {
  if (!Number.isFinite(value)) return "0.00%"
  if (value >= 100) return "100%"
  let decimals = 2
  // 每多一个 9 就多一位小数：99.9 → 3 位，99.99 → 4 位，99.999 → 5 位
  while (decimals < 6 && value >= 100 - 10 ** -(decimals - 1)) decimals++
  // 动作：按阈值精度格式化后剥掉无意义的尾零（至少留两位）→ 结果：99.9900 显示 99.99%，99.989 保持 99.989%
  const [int, frac = ""] = Math.max(0, value).toFixed(decimals).split(".")
  return `${int}.${frac.replace(/0+$/, "").padEnd(2, "0")}%`
}

/**
 * usage.ts
 * 核心流程：用量展示的纯函数 ——
 *           approxTokens  按 ASCII 4 字符 1 token、非 ASCII 1 字符 1 token 估算
 *           tokenRate     由 finish 分片的 output_tokens/generation_ms 计算吐字速率
 *           countChars    按 Unicode 码点计字符数（emoji 记 1）
 *           formatTokens  1.2K / 34K / 1.2M 紧凑格式
 *           formatChars   字符数同款紧凑格式
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

/**
 * usage.ts
 * 核心流程：token 用量展示的纯函数 ——
 *           approxTokens  按 ASCII 4 字符 1 token、非 ASCII 1 字符 1 token 估算
 *           tokenRate     由 finish 分片的 output_tokens/generation_ms 计算吐字速率
 *           formatTokens  1.2K / 34K / 1.2M 紧凑格式
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
 * formatTokens
 * 参数：n token 数
 * 核心流程：小于 1000 原样；千级保留一位小数（整数省略）；百万级同理
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) {
    const value = n / 1000
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}K`
  }
  const value = n / 1_000_000
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}M`
}

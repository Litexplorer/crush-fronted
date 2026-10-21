#!/usr/bin/env node
/**
 * gen-web-themes.mjs
 * 参数：环境变量 CRUSH_THEMES_DIR（源目录，默认 ~/.config/crush/themes）
 * 核心流程：读取 Crush TUI 主题 JSON → 映射为 Web 主题变量 →
 *           生成 src/lib/theme-palettes.generated.ts 与 src/themes.generated.css，
 *           同时在终端打印对比度巡检，低于阈值的主题会列出来
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SRC_DIR = process.env.CRUSH_THEMES_DIR || path.join(os.homedir(), ".config", "crush", "themes")
const ROOT = path.resolve(import.meta.dirname, "..")
const OUT_TS = path.join(ROOT, "src", "lib", "theme-palettes.generated.ts")
const OUT_CSS = path.join(ROOT, "src", "themes.generated.css")

/** 品牌名有小写/空格习惯，其余走通用分词 */
const LABEL_OVERRIDES = {
  github: "GitHub",
  tokyonight: "Tokyo Night",
  onedarkpro: "One Dark Pro",
  "one-dark": "One Dark",
  carbonfox: "Carbonfox",
  "oc-2": "OC 2",
  "osaka-jade": "Osaka Jade",
  "synthwave84": "Synthwave '84",
  "shadesofpurple": "Shades of Purple",
  "morandi-vivid-nightowl": "Morandi Vivid Night Owl",
  "morandi-vivid-nightwl": "Morandi Vivid Nightwl",
  "morandi-vivid-one-dark": "Morandi Vivid One Dark",
}

const THRESHOLDS = { text: 4.5, muted: 3, accent: 3 }

/**
 * normalizeHex
 * 参数：hex 源色值
 * 核心流程：3 位缩写展开为 6 位，其余原样返回，保证生成物格式统一
 */
function normalizeHex(hex) {
  const value = String(hex).trim()
  if (value.length === 4 && value.startsWith("#")) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
  }
  return value
}

function toRgb(hex) {
  const value = normalizeHex(hex).replace("#", "")
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function mix(a, b, ratio) {
  const ca = toRgb(a)
  const cb = toRgb(b)
  const parts = ca.map((c, i) => Math.round((c * (1 - ratio) + cb[i] * ratio) * 255))
  return `#${parts.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

function labelFor(id) {
  if (LABEL_OVERRIDES[id]) return LABEL_OVERRIDES[id]
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * mapTheme
 * 参数：id 主题文件名；src TUI 主题 JSON
 * 核心流程：TUI 三层可见度背景映射到页面/面板/悬浮 → 前景三层映射到正文/次要/提示，
 *           弱色倒挂时交换 → 强调色取 primary，边框用 separator 与前景混合
 */
function mapTheme(id, src) {
  const bgDeep = normalizeHex(src.bg_base)
  const bgBase = normalizeHex(src.bg_less_visible)
  const bgRaised = normalizeHex(src.bg_most_visible)
  const fgBase = normalizeHex(src.fg_base)
  let textMuted = normalizeHex(src.fg_subtle)
  let textFaint = normalizeHex(src.fg_more_subtle)
  // 少数主题（如 rosepine）的 more_subtle 反而更亮，交换以保持层级递减
  if (contrast(textFaint, bgDeep) > contrast(textMuted, bgDeep)) {
    ;[textMuted, textFaint] = [textFaint, textMuted]
  }
  // 个别主题（one-dark / palenight）的次要文字低于 3:1，向正文色提亮
  if (contrast(textMuted, bgDeep) < THRESHOLDS.muted) {
    textMuted = mix(textMuted, fgBase, 0.35)
  }
  return {
    id,
    label: labelFor(id),
    mode: luminance(bgDeep) > 0.5 ? "light" : "dark",
    bgDeep,
    bgBase,
    bgRaised,
    textBase: fgBase,
    textMuted,
    textFaint,
    borderBase: normalizeHex(src.separator),
    borderStrong: mix(normalizeHex(src.separator), fgBase, 0.3),
    accent: normalizeHex(src.primary),
    statusConnected: normalizeHex(src.success),
    statusDisconnected: normalizeHex(src.fg_most_subtle),
  }
}

function readThemes() {
  const files = fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
  const themes = []
  for (const name of files) {
    const id = name.slice(0, -".json".length)
    const raw = JSON.parse(fs.readFileSync(path.join(SRC_DIR, name), "utf8"))
    themes.push(mapTheme(id, raw))
  }
  return themes
}

function renderTs(themes) {
  const body = themes
    .map(
      (t) => `  {
    id: ${JSON.stringify(t.id)},
    label: ${JSON.stringify(t.label)},
    mode: ${JSON.stringify(t.mode)},
    bgDeep: ${JSON.stringify(t.bgDeep)},
    bgBase: ${JSON.stringify(t.bgBase)},
    bgRaised: ${JSON.stringify(t.bgRaised)},
    textBase: ${JSON.stringify(t.textBase)},
    textMuted: ${JSON.stringify(t.textMuted)},
    textFaint: ${JSON.stringify(t.textFaint)},
    borderBase: ${JSON.stringify(t.borderBase)},
    borderStrong: ${JSON.stringify(t.borderStrong)},
    accent: ${JSON.stringify(t.accent)},
    statusConnected: ${JSON.stringify(t.statusConnected)},
    statusDisconnected: ${JSON.stringify(t.statusDisconnected)},
  },`,
    )
    .join("\n")
  return `// 由 scripts/gen-web-themes.mjs 生成，请勿手改
// 源目录：${SRC_DIR}
export interface WebThemePalette {
  id: string
  label: string
  mode: "dark" | "light"
  bgDeep: string
  bgBase: string
  bgRaised: string
  textBase: string
  textMuted: string
  textFaint: string
  borderBase: string
  borderStrong: string
  accent: string
  statusConnected: string
  statusDisconnected: string
}

export const GENERATED_THEMES: WebThemePalette[] = [
${body}
]
`
}

function renderCss(themes) {
  const blocks = themes
    .map(
      (t) => `html[data-theme="${t.id}"] {
  color-scheme: ${t.mode};

  --bg-deep: ${t.bgDeep};
  --bg-base: ${t.bgBase};
  --bg-raised: ${t.bgRaised};
  --text-base: ${t.textBase};
  --text-muted: ${t.textMuted};
  --text-faint: ${t.textFaint};
  --border-base: ${t.borderBase};
  --border-strong: ${t.borderStrong};
  --accent: ${t.accent};
  --status-connected: ${t.statusConnected};
  --status-disconnected: ${t.statusDisconnected};
}`,
    )
    .join("\n\n")
  return `/* 由 scripts/gen-web-themes.mjs 生成，请勿手改 */
/* 源目录：${SRC_DIR} */

${blocks}
`
}

function audit(themes) {
  const rows = []
  for (const t of themes) {
    rows.push({
      id: t.id,
      text: contrast(t.textBase, t.bgDeep),
      muted: contrast(t.textMuted, t.bgDeep),
      accent: contrast(t.accent, t.bgDeep),
    })
  }
  const failed = rows.filter(
    (r) => r.text < THRESHOLDS.text || r.muted < THRESHOLDS.muted || r.accent < THRESHOLDS.accent,
  )
  console.log(`\n对比度巡检（text≥${THRESHOLDS.text} muted≥${THRESHOLDS.muted} accent≥${THRESHOLDS.accent}）`)
  console.log(`  ${"id".padEnd(30)}${"text".padStart(7)}${"muted".padStart(8)}${"accent".padStart(8)}`)
  for (const r of rows) {
    const flag = r.text < THRESHOLDS.text || r.muted < THRESHOLDS.muted || r.accent < THRESHOLDS.accent ? " !" : ""
    console.log(`  ${r.id.padEnd(30)}${r.text.toFixed(1).padStart(7)}${r.muted.toFixed(1).padStart(8)}${r.accent.toFixed(1).padStart(8)}${flag}`)
  }
  console.log(failed.length === 0 ? "  全部达标" : `  不达标 ${failed.length} 个：${failed.map((r) => r.id).join(", ")}`)
  return failed
}

function main() {
  const themes = readThemes()
  // --check：只做对比度巡检，不改写生成物，供 CI / 提交前检查
  if (process.argv.includes("--check")) {
    const failed = audit(themes)
    process.exitCode = failed.length > 0 ? 1 : 0
    return
  }
  fs.writeFileSync(OUT_TS, renderTs(themes))
  fs.writeFileSync(OUT_CSS, renderCss(themes))
  console.log(`读取 ${SRC_DIR}`)
  console.log(`生成 ${themes.length} 个主题`)
  console.log(`  ${path.relative(ROOT, OUT_TS)}`)
  console.log(`  ${path.relative(ROOT, OUT_CSS)}`)
  const failed = audit(themes)
  if (process.argv.includes("--strict") && failed.length > 0) process.exitCode = 1
}

main()

/**
 * clipboard.ts
 * 参数：text 待写入剪贴板的文本
 * 核心流程：优先用 navigator.clipboard（需要安全上下文）→ 失败回退到隐藏 textarea +
 *           execCommand，兼容 http 内网访问；两条路都不可用时返回 false
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒或非安全上下文：继续走兜底方案
  }

  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  } catch {
    return false
  }
}

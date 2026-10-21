/**
 * version.ts
 * 核心流程：GET /version → 后端版本信息（proto.VersionInfo），供会话信息弹窗页脚展示
 */
import { httpGet } from "./http"

/** 对应 internal/proto/version.go 的 proto.VersionInfo */
export interface VersionInfo {
  version: string
  commit: string
  build_id: string
  go_version: string
  platform: string
}

/**
 * getVersion
 * 参数：无
 * 核心流程：GET /version → 归一为对象；请求失败或返回空时抛错给调用方决定降级
 */
export async function getVersion(): Promise<VersionInfo> {
  const data = await httpGet<VersionInfo | null>("/version")
  return data ?? { version: "", commit: "", build_id: "", go_version: "", platform: "" }
}

/**
 * permissions.ts
 * 核心流程：权限链路三个接口的对接层 ——
 *           grantPermission POST /workspaces/{id}/permissions/grant（body PermissionGrant）
 *           getSkip         GET  /workspaces/{id}/permissions/skip → {skip}
 *           setSkip         POST /workspaces/{id}/permissions/skip（body PermissionSkipRequest）
 */
import { httpGet, httpPost } from "./http"

/** 对应 proto.PermissionRequest（internal/proto/permission.go），SSE permission_request 的载荷 */
export interface PermissionRequest {
  id: string
  session_id: string
  tool_call_id: string
  tool_name: string
  description: string
  action: string
  params?: unknown
  path?: string
}

/** 对应 proto.PermissionAction：allow 一次放行 / allow_session 本会话放行 / deny 拒绝 */
export type PermissionAction = "allow" | "allow_session" | "deny"

/** POST /permissions/grant 响应，对应 proto.PermissionGrantResponse；resolved=false 表示已被其他客户端处理 */
export interface PermissionGrantResponse {
  resolved: boolean
}

/**
 * grantPermission
 * 参数：wsId workspace ID；permission 待裁决的完整 PermissionRequest；action 用户决定
 * 核心流程：POST /permissions/grant（handlePostWorkspacePermissionsGrant），
 *           返回 resolved（false 不是错误：请求已被别的客户端裁决）
 */
export async function grantPermission(
  wsId: string,
  permission: PermissionRequest,
  action: PermissionAction,
): Promise<PermissionGrantResponse> {
  return httpPost<PermissionGrantResponse>(
    `/workspaces/${encodeURIComponent(wsId)}/permissions/grant`,
    { permission, action },
  )
}

/**
 * getSkip
 * 参数：wsId workspace ID
 * 核心流程：GET /permissions/skip（handleGetWorkspacePermissionsSkip），
 *           返回当前工作区是否跳过权限询问（YOLO 模式）
 */
export async function getSkip(wsId: string): Promise<boolean> {
  const data = await httpGet<{ skip: boolean }>(
    `/workspaces/${encodeURIComponent(wsId)}/permissions/skip`,
  )
  return data.skip
}

/**
 * setSkip
 * 参数：wsId workspace ID；skip 是否跳过权限询问
 * 核心流程：POST /permissions/skip（handlePostWorkspacePermissionsSkip），
 *           成功 200 无响应体；失败由调用方捕获并回滚 UI 状态
 */
export async function setSkip(wsId: string, skip: boolean): Promise<void> {
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/permissions/skip`, { skip })
}

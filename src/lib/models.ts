/**
 * models.ts
 * 核心流程：模型选择链路三个接口的对接层 ——
 *           listProviders      GET  /workspaces/{id}/providers → []catwalk.Provider（全量模型目录）
 *           getWorkspaceConfig GET  /workspaces/{id}/config   → config.Config（读 models.large 当前选择）
 *           setModel           POST /workspaces/{id}/config/model（scope 固定 workspace、model_type 固定 large）
 */
import { httpGet, httpPost } from "./http"

/** 对应 catwalk.Model（下拉展示 + 用量占比所需字段） */
export interface ProviderModel {
  id: string
  name: string
  context_window?: number
  default_max_tokens?: number
  can_reason?: boolean
  reasoning_levels?: string[]
  default_reasoning_effort?: string
  /** catwalk.SupportImages 的 JSON 名；true 表示模型可接收图片附件 */
  supports_attachments?: boolean
}

/** 对应 catwalk.Provider：id/name + 模型列表（下拉按 provider 分组渲染） */
export interface Provider {
  id: string
  name: string
  models?: ProviderModel[]
}

/** 对应 config.SelectedModel：后端存储的最小模型描述 */
export interface SelectedModel {
  model?: string
  provider?: string
  reasoning_effort?: string
  think?: boolean
}

/** 对应 config.Config：UI 消费 models 与自定义 providers（catwalk 目录之外的本地配置） */
export interface WorkspaceConfig {
  models?: {
    large?: SelectedModel
    small?: SelectedModel
  }
  providers?: Record<string, Provider>
}

/** setModel 入参：provider/model 必填，reasoning_effort/think 可选（undefined 序列化时省略） */
export interface SetModelInput {
  provider: string
  model: string
  reasoning_effort?: string
  think?: boolean
}

/** scope 常量：config.ScopeWorkspace = 1（int 序列化为数字），固定写 workspace 配置 */
const SCOPE_WORKSPACE = 1

/**
 * listProviders
 * 参数：wsId workspace ID
 * 核心流程：GET /providers，返回可用 provider 目录（含各 provider 的模型清单，供下拉分组渲染）
 */
export async function listProviders(wsId: string): Promise<Provider[]> {
  return httpGet<Provider[]>(`/workspaces/${encodeURIComponent(wsId)}/providers`)
}

/**
 * getWorkspaceConfig
 * 参数：wsId workspace ID
 * 核心流程：GET /config，返回工作区配置；调用方读取 models.large 作为当前模型选择
 */
export async function getWorkspaceConfig(wsId: string): Promise<WorkspaceConfig> {
  return httpGet<WorkspaceConfig>(`/workspaces/${encodeURIComponent(wsId)}/config`)
}

/**
 * setModel
 * 参数：wsId workspace ID；input 携带 provider/model/reasoning_effort/think
 * 核心流程：POST /config/model，body 为 {scope, model_type, model}；
 *           scope 固定 workspace、model_type 固定 large，成功返回 200 无响应体
 */
export async function setModel(wsId: string, input: SetModelInput): Promise<void> {
  await httpPost(`/workspaces/${encodeURIComponent(wsId)}/config/model`, {
    scope: SCOPE_WORKSPACE,
    model_type: "large",
    model: {
      model: input.model,
      provider: input.provider,
      ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
      ...(input.think !== undefined ? { think: input.think } : {}),
    },
  })
}

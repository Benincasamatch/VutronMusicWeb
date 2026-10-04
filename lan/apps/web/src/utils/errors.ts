import { ApiError } from '../api/client'
import type { ClientErrorCode } from '../api/client'

const messages: Record<ClientErrorCode, string> = {
  VALIDATION_ERROR: '输入不符合要求，请检查后重试。',
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  FORBIDDEN: '当前账号没有执行此操作的权限，正在重新确认身份。',
  ORIGIN_REJECTED: '访问地址未获服务器允许，请使用管理员提供的地址。',
  CSRF_INVALID: '会话验证已变化，正在重新同步。请确认状态后重新操作。',
  RATE_LIMITED: '操作过于频繁，请稍等片刻再试。',
  NOT_FOUND: '歌曲或待播条目已不存在，请查看最新状态。',
  INSTANCE_CONFLICT: '服务器已重新启动，正在重新同步。此次操作不会自动重试。',
  REVISION_CONFLICT: '其他人已更新听音室，正在同步。请确认后重新操作。',
  PLAYBACK_CONFLICT: '当前播放已改变。请确认歌曲后重新操作。',
  REQUEST_ID_REUSED: '请求标识冲突，此次操作未重试。请刷新状态。',
  QUEUE_FULL: '待播队列已满，请等待播放或移除待播歌曲。',
  TRACK_UNAVAILABLE: '此本地文件暂时不可用，请联系管理员检查文件。',
  PLAYER_UNAVAILABLE: '实体播放器不可用，请联系管理员检查 mpv 与音频设备。',
  PLAYBACK_FAILED: '实体播放器未能完成播放，请查看当前状态或联系管理员。',
  USERNAME_TAKEN: '这个账号名已被使用，请换一个。',
  LAST_ADMIN: '必须保留至少一位管理员。',
  USER_LIMIT: '账号数量已达到上限。',
  INTERNAL_ERROR: '服务器未能完成操作，请稍后查看状态。',
  NETWORK_ERROR: '无法确认请求结果。恢复连接后请先查看最新状态，不要重复提交。',
  PROTOCOL_ERROR: '服务器响应无法验证，操作已停止。请重新连接或联系管理员。'
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] : messages.VALIDATION_ERROR
}

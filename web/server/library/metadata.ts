/**
 * music-metadata 加载桥。
 *
 * 背景：web/tsconfig.json 使用 moduleResolution: "bundler"，而 music-metadata 的 exports map
 * 只在 "node" 条件下列出含 parseFile 的入口；bundler 解析落到浏览器安全的 core 入口，
 * TypeScript 因此看不到 parseFile（运行时 Node 的 "node" 导出一致提供 parseFile）。
 * 这里用 ESM 命名空间导入（运行时正确），并显式声明本库实际用到的最小类型面。
 */
import * as musicMetadata from 'music-metadata'

export interface AudioPicture {
  data: Uint8Array
  format: string
}

export interface AudioMetadata {
  common: {
    title?: string
    artist?: string
    album?: string
    albumartist?: string
    track?: { no: number | null } | null
    disk?: { no: number | null } | null
    picture?: AudioPicture[]
  }
  format: {
    duration?: number
  }
}

export type ParseAudioFile = (
  filePath: string,
  options?: { duration?: boolean }
) => Promise<AudioMetadata>

// 收窄即为补偿上述导出口径差异：运行时 node 入口含 parseFile，bundler 类型不含
const metadataApi = musicMetadata as unknown as { parseFile?: ParseAudioFile }

export const parseAudioFile: ParseAudioFile = (filePath, options) => {
  if (!metadataApi.parseFile) throw new Error('music-metadata 未提供 parseFile（入口解析异常）')
  return metadataApi.parseFile(filePath, options)
}

/**
 * 歌词工具：从桌面版 src/main/utils/index.ts 移植（去掉 electron / db / store 等宿主依赖）。
 * 供插件 Worker 的 apis.utils.parseLyric/getEmbeddedLyric/getPathLyric 使用。
 */
import fs from 'node:fs'
// music-metadata v10 的 exports 映射分「node 条件」(lib/index.js，导出 parseFile) 与
// 「浏览器条件」(lib/core.d.ts，无 parseFile)。web/tsconfig 的 moduleResolution=bundler
// 只会解析到后者，但运行时由 Node/tsx 按 "node" 条件加载，parseFile 一定存在。
// @ts-expect-error bundler 类型解析与运行时实际导出不一致
import { parseFile } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'

export interface LyricWord {
  start: number
  end: number
  word: string
}

export interface LyricPart {
  text: string
  info?: LyricWord[]
}

export interface LyricLine {
  start: number
  end: number
  lyric: LyricPart
  tlyric?: LyricPart
  rlyric?: LyricPart
}

const EXTRACT_LINE_REGEX = /^(?<lyricTimestamps>(?:\[.+?\])+)(?!\[)(?<content>.+)$/gm
const CHINESE_REGEX = /[\u4E00-\u9FFF]/

type LineMatch = RegExpExecArray & { groups: { lyricTimestamps: string; content: string } }

const _parseYrcLine = (line: LineMatch): LyricLine | undefined => {
  const timestampRegex = /\[(\d+),(\d+)\]/g
  const extractTimestampRegex = /\((\d+),(\d+),\d+\)([^(]+)/g

  const { lyricTimestamps, content } = line.groups
  const startTime = lyricTimestamps.match(timestampRegex)
  const times = startTime
    ? startTime.flatMap((match) => {
        const [, num1, num2] = match.match(/\[(\d+),(\d+)\]/) || []
        return [Number(num1) / 1000, Number(num2) / 1000]
      })
    : []
  if (times.length === 0) return
  const matched = content.matchAll(extractTimestampRegex)
  const info = [...matched].map((match) => {
    let [, start, duration, word] = match
    start = Math.max(parseInt(start), 100).toString()
    return { start: parseInt(start), end: parseInt(start) + parseInt(duration), word }
  })
  const text = info.map((item) => item.word).join('')
  return { start: times[0], end: times[0] + times[1], lyric: { info, text } }
}

const _parseLrcLine = (line: LineMatch) => {
  const extractTimestampRegex = /\[(?<min>\d+):(?<sec>\d+)(?:\.|:)*(?<ms>\d+)*\]/g

  const { lyricTimestamps, content } = line.groups
  let start = 0

  const match = extractTimestampRegex.exec(lyricTimestamps)
  if (match?.groups) {
    const { min, sec, ms } = match.groups
    start = Number(min) * 60 + Number(sec) + Number(ms?.padEnd(3, '0') ?? 0) * 0.001
    start = Number(start.toFixed(3))
  }
  const cInfo = content.replace(/\[(\d+):(\d+)(?:\.|:)*(\d+)]/g, '').trim()
  return { start, cInfo }
}

const _switchTime = (str: string, regex: RegExp) => {
  const match = str.matchAll(regex)
  const [, min, sec, ms] = [...match].flat()
  return Number(
    Math.round(
      (Number(min) * 60 + Number(sec) + Number(ms?.padEnd(3, '0') ?? 0) * 0.001) * 1000
    ).toFixed(3)
  )
}

const _parseWrcLine = (line: LineMatch): LyricLine | undefined => {
  const regex = /(\[\d{2}:\d{2}\.\d{1,3}\])([^[]*?)(?=(\[\d{2}:\d{2}\.\d{2,3}\]))/g
  const extractTimestampRegex = /\[(?<min>\d+):(?<sec>\d+)(?:\.|:)*(?<ms>\d+)*\]/g

  const { lyricTimestamps, content } = line.groups
  const lineText = lyricTimestamps + content
  const words = lineText.trim().matchAll(regex)
  const ws = [...words]
  if (!ws.length) return
  const info = ws.map((word) => {
    const start = Math.max(50, _switchTime(word[1], extractTimestampRegex))
    const end = _switchTime(word[3], extractTimestampRegex)
    return { start, end, word: word[2] }
  })

  const start = Number((info[0].start / 1000).toFixed(3))
  const end = Number((info.at(-1)!.end / 1000).toFixed(3))
  const text = info.map((item) => item.word).join('')
  return { start, end, lyric: { info, text } }
}

const _parseEnhancedLrcLine = (line: LineMatch): LyricLine | undefined => {
  const { lyricTimestamps, content } = line.groups
  const converted = content
    .replace(/^<[\d:.]+>/, '') // 去掉开头与行时间戳重复的那个
    .replace(/<([\d:.]+)>/g, '[$1]')
  const fakeMatch = Object.assign([lyricTimestamps + converted] as unknown as LineMatch, {
    index: 0,
    input: lyricTimestamps + converted,
    groups: { lyricTimestamps, content: converted }
  })
  const result = _parseWrcLine(fakeMatch)
  if (result?.lyric?.info) {
    result.lyric.info = result.lyric.info.filter((item) => item.word.trim() !== '')
    result.lyric.text = result.lyric.info.map((item) => item.word).join('')
  }
  return result
}

export const parseLyricString = (lyrics: string): LyricLine[] => {
  if (!lyrics) return []

  const result: LyricLine[] = []
  const lyricMap = new Map<number, LyricLine[]>()
  const lrcResult: LyricLine[] = []

  for (const line of lyrics.trim().matchAll(EXTRACT_LINE_REGEX)) {
    const { content } = line.groups as { content: string }
    if (/\(\d+,\d+,\d+\)/.test(content)) {
      const lyric = _parseYrcLine(line as LineMatch)!
      if (!lyricMap.has(lyric.start)) lyricMap.set(lyric.start, [])
      lyricMap.get(lyric.start)!.push(lyric)
    } else if (/\[\d{2}:\d{2}\.\d{3}\]/.test(content)) {
      const lyric = _parseWrcLine(line as LineMatch)!
      if (!lyricMap.has(lyric.start)) lyricMap.set(lyric.start, [])
      lyricMap.get(lyric.start)?.push(lyric)
    } else if (/^<[\d:.]+>/.test(content)) {
      const lyric = _parseEnhancedLrcLine(line as LineMatch)
      if (!lyric) continue
      if (!lyricMap.has(lyric.start)) lyricMap.set(lyric.start, [])
      lyricMap.get(lyric.start)!.push(lyric)
    } else {
      const _line = _parseLrcLine(line as LineMatch)
      const lyric = { start: _line.start, end: 0, lyric: { text: _line.cInfo } }
      lrcResult.push(lyric)
    }
  }

  lrcResult.forEach((line, index) => {
    const nextLine = lrcResult[index + 1]
    if (nextLine) line.end = nextLine.start

    if (!lyricMap.has(line.start)) lyricMap.set(line.start, [])
    lyricMap.get(line.start)?.push(line)
  })

  for (const lyricArray of lyricMap.values()) {
    for (let i = 0; i < lyricArray.length; i++) {
      if (i === 0) {
        result.push(lyricArray[0])
      } else {
        const line = result.find((item) => item.start === lyricArray[i].start)
        if (line) {
          if (CHINESE_REGEX.test(lyricArray[i].lyric.text)) {
            line.tlyric = line.tlyric ?? lyricArray[i].lyric
          } else {
            line.rlyric = lyricArray[i].lyric
          }
        }
      }
    }
  }
  return result
}

export const yrcLyricParse = (data: {
  yrc?: { lyric?: string }
  ytlrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
}): LyricLine[] | undefined => {
  const mainLyric = data.yrc?.lyric
  if (!mainLyric) return
  const result: LyricLine[] = []

  const binarySearch = (lyric: LyricLine) => {
    const time = lyric.start
    let low = 0
    let high = result.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const midTime = result[mid].start
      if (midTime === time) return mid
      else if (midTime < time) low = mid + 1
      else high = mid - 1
    }
    return low
  }

  for (const line of mainLyric.trim().matchAll(EXTRACT_LINE_REGEX)) {
    const lyric = _parseYrcLine(line as LineMatch)!
    result.splice(binarySearch(lyric), 0, lyric)
  }

  const lrcList = ['ytlrc', 'yromalrc'] as const
  const lrcMap = { ytlrc: 'tlyric', yromalrc: 'rlyric' } as const
  lrcList.forEach((lrc) => {
    const text = data[lrc]?.lyric
    if (!text) return
    for (const line of text.trim().matchAll(EXTRACT_LINE_REGEX)) {
      const { start, cInfo } = _parseLrcLine(line as LineMatch)
      const matchedLyric = result.find((lyric) => lyric.start === start)
      if (!matchedLyric) continue
      const _start = matchedLyric.lyric.info
        ? matchedLyric.lyric.info[0].start
        : matchedLyric.start * 1000
      const end = matchedLyric.lyric.info
        ? matchedLyric.lyric.info.at(-1)!.end
        : matchedLyric.end * 1000
      const info = [{ start: Math.max(100, _start), end, word: cInfo }]
      matchedLyric[lrcMap[lrc]] = { info, text: cInfo }
    }
  })

  return result
}

export const lrcLyricParse = (data: {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
}): LyricLine[] | undefined => {
  const mainLyric = data.lrc?.lyric
  if (!mainLyric) return
  const result: LyricLine[] = []

  const binarySearch = (lyric: LyricLine) => {
    const time = lyric.start
    let low = 0
    let high = result.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const midTime = result[mid].start
      if (midTime === time) return mid
      else if (midTime < time) low = mid + 1
      else high = mid - 1
    }
    return low
  }

  for (const line of mainLyric.trim().matchAll(EXTRACT_LINE_REGEX)) {
    const _line = _parseLrcLine(line as LineMatch)
    const lyric = { start: _line.start, end: 0, lyric: { text: _line.cInfo } }
    result.splice(binarySearch(lyric), 0, lyric)
  }

  const lrcList = ['tlyric', 'romalrc'] as const
  const lrcMap = { tlyric: 'tlyric', romalrc: 'rlyric' } as const

  lrcList.forEach((lrc) => {
    const text = data[lrc]?.lyric
    if (!text) return
    for (const line of text.trim().matchAll(EXTRACT_LINE_REGEX)) {
      const { start, cInfo } = _parseLrcLine(line as LineMatch)
      const matchedLyric = result.find((lyric) => lyric.start === start)
      if (!matchedLyric) continue
      matchedLyric[lrcMap[lrc]] = { text: cInfo }
    }
  })

  result.forEach((line, index) => {
    const nextLine = result[index + 1]
    if (nextLine) line.end = nextLine.start
  })

  return result
}

/** 与桌面版 pluginManager 的 LYRIC_PARSE 分支保持一致：支持 { yrc } / { lrc } 对象或纯文本 */
export function parseLyricInput(input: unknown): LyricLine[] {
  if (typeof input === 'string') return parseLyricString(input)
  if (input && typeof input === 'object') {
    const obj = input as { yrc?: { lyric?: string }; lrc?: { lyric?: string } }
    if (obj.yrc?.lyric) return yrcLyricParse(obj) ?? []
    if (obj.lrc?.lyric) return lrcLyricParse(obj) ?? []
  }
  return []
}

// Vorbis Comment 歌词字段（FLAC/OGG），按优先级排列
const VORBIS_LYRIC_IDS = ['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS']
// ID3v2 歌词帧（MP3）
const ID3_LYRIC_IDS = ['USLT', 'SYLT']
// APEv2 歌词字段（APE/WV），大小写不敏感匹配
const APE_LYRIC_IDS = ['LYRICS', 'UNSYNCEDLYRICS']

function syncTextToLines(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((entry: unknown) =>
      entry && typeof entry === 'object' && 'text' in entry ? String(entry.text) : ''
    )
    .join('\n')
}

/** ID3v2 的 USLT 取 text，SYLT 拼接 syncText；其余标签（vorbis/APEv2）值即字符串 */
function extractTagText(tagType: string, value: unknown): string {
  if (tagType === 'ID3v2.3' || tagType === 'ID3v2.4') {
    if (value && typeof value === 'object') {
      if ('text' in value && typeof value.text === 'string') return value.text
      if ('syncText' in value) return syncTextToLines(value.syncText)
    }
    return ''
  }
  return typeof value === 'string' ? value : ''
}

/** 从音频元数据中提取歌词文本：优先原生标签（Vorbis/ID3v2/APEv2），兜底 common.lyrics */
function getLyricTextFromMetadata(metadata: IAudioMetadata): string {
  for (const tagType of metadata.format.tagTypes ?? []) {
    let lyricIds: string[] | null = null
    if (tagType === 'vorbis') lyricIds = VORBIS_LYRIC_IDS
    else if (tagType === 'ID3v2.3' || tagType === 'ID3v2.4') lyricIds = ID3_LYRIC_IDS
    else if (tagType === 'APEv2') lyricIds = APE_LYRIC_IDS
    if (!lyricIds) continue

    const tags = metadata.native[tagType]
    if (!Array.isArray(tags)) continue
    for (const id of lyricIds) {
      const tag = tags.find(
        (entry) => String(entry.id ?? '').toUpperCase() === id
      )
      if (!tag) continue
      const lyrics = extractTagText(tagType, tag.value)
      if (lyrics) return lyrics
    }
  }

  const fallback = metadata.common.lyrics
  if (!Array.isArray(fallback) || fallback.length === 0) return ''
  const first: unknown = fallback[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') {
    if ('syncText' in first) {
      const lines = syncTextToLines(first.syncText)
      if (lines) return lines
    }
    if ('text' in first && typeof first.text === 'string') return first.text
  }
  return ''
}

export async function getEmbeddedLyric(filePath: string): Promise<LyricLine[]> {
  const metadata = await parseFile(decodeURI(filePath))
  const lyrics = getLyricTextFromMetadata(metadata)
  return lyrics ? parseLyricString(lyrics) : []
}

export async function getPathLyric(filePath: string): Promise<LyricLine[]> {
  const lyrics = await fs.promises.readFile(filePath, 'utf8')
  return lyrics ? parseLyricString(lyrics) : []
}

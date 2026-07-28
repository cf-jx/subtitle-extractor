import type {
  JobSnapshot,
  JobStage,
  SubtitleSegment,
} from '../backend/types'

export const terminalStages = new Set<JobStage>([
  'completed',
  'failed',
  'cancelled',
])

const supportedVideoHosts = new Set([
  'douyin.com',
  'www.douyin.com',
  'm.douyin.com',
  'v.douyin.com',
  'iesdouyin.com',
  'www.iesdouyin.com',
  'tiktok.com',
  'www.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
])

function isSingleVideoPath(hostname: string, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/'

  if (hostname === 'v.douyin.com') {
    return /^\/[A-Za-z0-9_-]+$/.test(path)
  }
  if (hostname === 'iesdouyin.com' || hostname === 'www.iesdouyin.com') {
    return /^\/share\/video\/\d+$/.test(path)
  }
  if (
    hostname === 'douyin.com' ||
    hostname === 'www.douyin.com' ||
    hostname === 'm.douyin.com'
  ) {
    return /^\/(?:video|share\/video)\/\d+$/.test(path)
  }
  if (hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com') {
    return /^\/[A-Za-z0-9_-]+$/.test(path)
  }
  if (hostname === 'tiktok.com' || hostname === 'www.tiktok.com') {
    return (
      /^\/@[^/]+\/video\/\d+$/.test(path) ||
      /^\/t\/[A-Za-z0-9_-]+$/.test(path)
    )
  }
  return false
}

export function validateVideoUrl(value: string): string | null {
  if (value.trim() === '') {
    return '请输入抖音或 TikTok 视频链接'
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return '请输入完整的 HTTPS 视频链接'
  }

  if (url.protocol !== 'https:') {
    return '仅支持 HTTPS 视频链接'
  }

  if (url.username !== '' || url.password !== '') {
    return '视频链接不能包含账号信息'
  }

  if (url.port !== '' && url.port !== '443') {
    return '链接端口不受支持'
  }

  const hostname = url.hostname.toLowerCase()
  if (hostname.endsWith('.') || !supportedVideoHosts.has(hostname)) {
    return '仅支持抖音或 TikTok 视频链接'
  }

  return isSingleVideoPath(hostname, url.pathname)
    ? null
    : '只支持单个视频链接，不支持主页、直播或图集'
}

export function formatTimestamp(milliseconds: number): string {
  const safeValue = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(safeValue / 3_600_000)
  const minutes = Math.floor((safeValue % 3_600_000) / 60_000)
  const seconds = Math.floor((safeValue % 60_000) / 1_000)
  const millis = safeValue % 1_000

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':')
    .concat(',', millis.toString().padStart(3, '0'))
}

export function filenameFromPath(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.at(-1) || path
}

export function transcriptToPlainText(segments: SubtitleSegment[]): string {
  return segments
    .toSorted((left, right) => left.index - right.index)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n')
}

export function upsertJob(
  jobs: JobSnapshot[],
  incoming: JobSnapshot,
): JobSnapshot[] {
  const existingIndex = jobs.findIndex((job) => job.id === incoming.id)
  if (existingIndex === -1) {
    return [incoming, ...jobs]
  }
  if (incoming.revision <= jobs[existingIndex].revision) {
    return jobs
  }

  const next = jobs.slice()
  next[existingIndex] = incoming
  return next
}

export function isJobActive(stage: JobStage): boolean {
  return !terminalStages.has(stage) && stage !== 'queued'
}

export function normalizeProgress(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) {
    return null
  }
  return Math.min(100, Math.max(0, progress))
}

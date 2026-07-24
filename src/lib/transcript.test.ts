import { describe, expect, it } from 'vitest'
import type { JobSnapshot } from '../backend/types'
import {
  formatTimestamp,
  normalizeProgress,
  transcriptToPlainText,
  upsertJob,
  validateVideoUrl,
} from './transcript'

describe('validateVideoUrl', () => {
  it.each([
    'https://www.douyin.com/video/7381234567890123456',
    'https://v.douyin.com/abc123/',
    'https://www.iesdouyin.com/share/video/7381234567890123456/',
    'https://www.tiktok.com/@creator/video/7381234567890123456',
    'https://vm.tiktok.com/ZM12345/',
    'https://vt.tiktok.com/ZM12345/',
    'https://www.tiktok.com/t/ZM12345/',
  ])('accepts a supported public HTTPS URL: %s', (url) => {
    expect(validateVideoUrl(url)).toBeNull()
  })

  it.each([
    'http://www.douyin.com/video/1',
    'https://tiktok.com.evil.example/video/1',
    'https://douyin.com@evil.example/video/1',
    'https://127.0.0.1/video/1',
    'file:///tmp/video.mp4',
    'https://www.douyin.com/user/creator',
    'https://www.douyin.com/note/7381234567890123456',
    'https://www.tiktok.com/@creator',
    'https://www.tiktok.com/@creator/live',
  ])('rejects an unsafe or unsupported URL: %s', (url) => {
    expect(validateVideoUrl(url)).not.toBeNull()
  })
})

describe('transcript helpers', () => {
  it('formats timestamps and plain text deterministically', () => {
    expect(formatTimestamp(5_240)).toBe('00:00:05,240')
    expect(
      transcriptToPlainText([
        { index: 1, startMs: 1_000, endMs: 2_000, text: ' 第二段 ' },
        { index: 0, startMs: 0, endMs: 1_000, text: '第一段' },
      ]),
    ).toBe('第一段\n第二段')
  })

  it('clamps known progress and preserves unknown progress', () => {
    expect(normalizeProgress(null)).toBeNull()
    expect(normalizeProgress(-4)).toBe(0)
    expect(normalizeProgress(128)).toBe(100)
  })

  it('updates an existing job without duplicating it', () => {
    const job: JobSnapshot = {
      id: 'job-1',
      sourceKind: 'local',
      source: '/tmp/video.mp4',
      displayName: 'video.mp4',
      outputDir: '/tmp',
      stage: 'queued',
      stageProgress: null,
      overallProgress: 0,
      message: '等待处理',
      createdAt: '2026-07-24T12:00:00+08:00',
      segments: [],
      outputs: null,
      error: null,
    }
    const updated = { ...job, stage: 'transcribing' as const, overallProgress: 50 }

    expect(upsertJob([job], updated)).toEqual([updated])
  })
})

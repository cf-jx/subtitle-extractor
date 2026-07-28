import type {
  DesktopBackend,
  ExportTranscriptRequest,
  JobSnapshot,
  StartJobRequest,
} from './types'
import type { UpdateService } from '../update/types'

const previewJob: JobSnapshot = {
  id: 'preview-job',
  revision: 4,
  sourceKind: 'local',
  source: '/Users/scf/Videos/休息与学习.mp4',
  displayName: '休息与学习.mp4',
  outputDir: '/Users/scf/Desktop/文案提取',
  stage: 'completed',
  stageProgress: 100,
  overallProgress: 100,
  message: '字幕已导出',
  createdAt: '2026-07-25T13:18:00+08:00',
  segments: [
    { index: 1, startMs: 101_920, endMs: 103_920, text: '你休息的时候' },
    { index: 2, startMs: 103_920, endMs: 105_440, text: '好好地休息' },
    { index: 3, startMs: 105_440, endMs: 106_560, text: '学习的时候' },
    { index: 4, startMs: 106_560, endMs: 107_640, text: '好好学习' },
    { index: 5, startMs: 107_640, endMs: 109_480, text: '这样才可以' },
    { index: 6, startMs: 109_480, endMs: 111_560, text: '让自己变得更好' },
    { index: 7, startMs: 111_560, endMs: 113_680, text: '以后遇到困难的时候' },
    {
      index: 8,
      startMs: 113_680,
      endMs: 116_200,
      text: '也才有足够的能力去解决它',
    },
  ],
  outputs: {
    txt: '/Users/scf/Desktop/文案提取/休息与学习.txt',
    srt: null,
    vtt: null,
  },
  error: null,
}

const previewSecondJob: JobSnapshot = {
  ...previewJob,
  id: 'preview-job-2',
  revision: 2,
  source: '/Users/scf/Videos/采访片段.mp4',
  displayName: '采访片段.mp4',
  message: '字幕提取完成',
  createdAt: '2026-07-25T12:46:00+08:00',
  segments: [],
  outputs: {
    txt: null,
    srt: '/Users/scf/Desktop/文案提取/采访片段.srt',
    vtt: null,
  },
}

export const previewDraft = {
  sourceKind: 'local' as const,
  localPath: previewJob.source,
  url: '',
  outputDir: previewJob.outputDir,
}

export const previewBackend: DesktopBackend = {
  availability: { available: true, reason: null },
  async getAppInfo() {
    return {
      platform: 'macos',
      modelName: 'Whisper Small',
      modelReady: true,
    }
  },
  async listJobs() {
    return [previewJob, previewSecondJob]
  },
  async startJob(_request: StartJobRequest) {},
  async cancelJob() {},
  async exportTranscript(request: ExportTranscriptRequest) {
    return {
      ...previewJob,
      revision: previewJob.revision + 1,
      segments: request.segments,
      message: '字幕已导出',
    }
  },
  async openOutputDirectory() {},
  async pickMedia() {
    return previewJob.source
  },
  async pickOutputDirectory() {
    return previewJob.outputDir
  },
  async subscribeJobUpdates() {
    return () => undefined
  },
  async subscribeFileDrops() {
    return () => undefined
  },
}

export const previewUpdateService: UpdateService = {
  available: true,
  async check() {
    return {
      currentVersion: '0.2.0',
      version: '0.2.1',
      notes: '优化自动更新体验\n修复字幕导出问题',
      async downloadAndInstall() {},
    }
  },
  async relaunch() {},
}

import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  AppInfo,
  DesktopBackend,
  ExportTranscriptRequest,
  FileDropEvent,
  JobSnapshot,
  StartJobRequest,
  Unlisten,
} from './types'

const unavailableReason =
  '当前是浏览器预览，选择文件、提取和导出仅在桌面应用中可用。'

export class BackendUnavailableError extends Error {
  constructor() {
    super(unavailableReason)
    this.name = 'BackendUnavailableError'
  }
}

function requireDesktopRuntime(): void {
  if (!isTauri()) {
    throw new BackendUnavailableError()
  }
}

function firstSelectedPath(
  selection: string | string[] | null,
): string | null {
  if (Array.isArray(selection)) {
    return selection[0] ?? null
  }
  return selection
}

export const tauriBackend: DesktopBackend = {
  availability: {
    available: isTauri(),
    reason: isTauri() ? null : unavailableReason,
  },

  async getAppInfo(): Promise<AppInfo> {
    requireDesktopRuntime()
    return invoke<AppInfo>('get_app_info')
  },

  async listJobs(): Promise<JobSnapshot[]> {
    requireDesktopRuntime()
    return invoke<JobSnapshot[]>('list_jobs')
  },

  async startJob(request: StartJobRequest): Promise<void> {
    requireDesktopRuntime()
    await invoke('start_job', { request })
  },

  async cancelJob(jobId: string): Promise<void> {
    requireDesktopRuntime()
    await invoke('cancel_job', { jobId })
  },

  async exportTranscript(request: ExportTranscriptRequest): Promise<void> {
    requireDesktopRuntime()
    await invoke('export_transcript', { request })
  },

  async openOutputDirectory(jobId: string): Promise<void> {
    requireDesktopRuntime()
    await invoke('open_output_directory', { jobId })
  },

  async pickMedia(): Promise<string | null> {
    requireDesktopRuntime()
    const selection = await open({
      title: '选择视频或音频',
      multiple: false,
      directory: false,
      filters: [
        {
          name: '视频与音频',
          extensions: [
            'mp4',
            'mov',
            'mkv',
            'webm',
            'avi',
            'm4v',
            'mpeg',
            'mpg',
            'wmv',
            'mp3',
            'm4a',
            'wav',
            'aac',
            'flac',
            'ogg',
            'opus',
          ],
        },
      ],
    })
    return firstSelectedPath(selection)
  },

  async pickOutputDirectory(): Promise<string | null> {
    requireDesktopRuntime()
    const selection = await open({
      title: '选择输出位置',
      multiple: false,
      directory: true,
      canCreateDirectories: true,
    })
    return firstSelectedPath(selection)
  },

  async subscribeJobUpdates(
    listener: (snapshot: JobSnapshot) => void,
  ): Promise<Unlisten> {
    requireDesktopRuntime()
    return listen<JobSnapshot>('job://updated', ({ payload }) => {
      listener(payload)
    })
  },

  async subscribeFileDrops(
    listener: (event: FileDropEvent) => void,
  ): Promise<Unlisten> {
    requireDesktopRuntime()
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      listener({
        type: payload.type,
        paths: 'paths' in payload ? payload.paths : [],
      })
    })
  },
}

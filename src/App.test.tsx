import { act, render, screen, within } from '@testing-library/react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopBackend,
  FileDropEvent,
  JobSnapshot,
} from './backend/types'
import App from './App'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async () => undefined),
}))

const processingJob: JobSnapshot = {
  id: 'job-1',
  sourceKind: 'url',
  source: 'https://www.douyin.com/video/7381234567890123456',
  displayName: '访谈视频.mp4',
  outputDir: '/Users/tester/Documents/文案输出',
  stage: 'transcribing',
  stageProgress: 46,
  overallProgress: 68,
  message: '正在识别字幕',
  createdAt: '2026-07-24T14:32:18+08:00',
  segments: [
    {
      index: 0,
      startMs: 0,
      endMs: 5_240,
      text: '这是一段正在本地处理的视频文案。',
    },
    {
      index: 1,
      startMs: 5_240,
      endMs: 10_480,
      text: '所有视频和字幕都不会上传到服务器。',
    },
  ],
  outputs: null,
  error: null,
}

interface BackendFixture {
  backend: DesktopBackend
  emitJob: (job: JobSnapshot) => void
  emitFileDrop: (event: FileDropEvent) => void
}

function createBackend(
  overrides: Partial<DesktopBackend> = {},
): BackendFixture {
  const jobListeners = new Set<(snapshot: JobSnapshot) => void>()
  const fileDropListeners = new Set<(event: FileDropEvent) => void>()

  const backend: DesktopBackend = {
    availability: { available: true, reason: null },
    getAppInfo: vi.fn(async () => ({
      platform: 'macos',
      modelName: 'Whisper Small',
      modelReady: true,
    })),
    listJobs: vi.fn(async () => []),
    startJob: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => undefined),
    exportTranscript: vi.fn(async () => undefined),
    openOutputDirectory: vi.fn(async () => undefined),
    pickMedia: vi.fn(async () => '/Users/tester/Videos/示例视频.mp4'),
    pickOutputDirectory: vi.fn(async () => '/Users/tester/Documents/文案输出'),
    subscribeJobUpdates: vi.fn(async (listener) => {
      jobListeners.add(listener)
      return () => jobListeners.delete(listener)
    }),
    subscribeFileDrops: vi.fn(async (listener) => {
      fileDropListeners.add(listener)
      return () => fileDropListeners.delete(listener)
    }),
    ...overrides,
  }

  return {
    backend,
    emitJob: (job) => {
      for (const listener of jobListeners) {
        listener(job)
      }
    },
    emitFileDrop: (event) => {
      for (const listener of fileDropListeners) {
        listener(event)
      }
    },
  }
}

describe('App', () => {
  it('shows a clear unavailable state in a regular browser', () => {
    const { backend } = createBackend({
      availability: {
        available: false,
        reason: '当前是浏览器预览，选择文件、提取和导出仅在桌面应用中可用。',
      },
    })

    render(<App backend={backend} />)

    expect(
      screen.getByText(
        '当前是浏览器预览，选择文件、提取和导出仅在桌面应用中可用。',
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeDisabled()
    expect(backend.listJobs).not.toHaveBeenCalled()
  })

  it('disables extraction when the local subtitle model is missing', async () => {
    const { backend } = createBackend({
      getAppInfo: vi.fn(async () => ({
        platform: 'windows',
        modelName: 'Whisper Small',
        modelReady: false,
      })),
    })

    render(<App backend={backend} />)

    expect(await screen.findByText('缺少本地字幕模型')).toBeVisible()
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeDisabled()
  })

  it('starts a local-file job with the selected output directory', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    render(<App backend={backend} />)

    await screen.findByText('暂无任务')
    await user.click(screen.getByTestId('media-drop-zone'))
    expect(screen.getByText('示例视频.mp4')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '选择' }))
    await user.click(screen.getByRole('button', { name: /SRT.*通用字幕/ }))
    await user.click(screen.getByRole('button', { name: /开始提取/ }))

    expect(backend.startJob).toHaveBeenCalledWith({
      sourceKind: 'local',
      source: '/Users/tester/Videos/示例视频.mp4',
      outputDir: '/Users/tester/Documents/文案输出',
      exportFormat: 'srt',
    })
  })

  it('rejects unsupported URLs before invoking the backend', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    render(<App backend={backend} />)

    await screen.findByText('暂无任务')
    await user.click(screen.getByRole('tab', { name: '视频链接' }))
    const input = screen.getByLabelText('视频链接')
    await user.type(input, 'https://tiktok.com.evil.example/video/1')

    expect(screen.getByText('仅支持抖音或 TikTok 视频链接')).toBeVisible()
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeDisabled()
    expect(backend.startJob).not.toHaveBeenCalled()
  })

  it('rejects video URLs containing credentials', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    render(<App backend={backend} />)

    await screen.findByText('暂无任务')
    await user.click(screen.getByRole('tab', { name: '视频链接' }))
    await user.type(
      screen.getByLabelText('视频链接'),
      'https://user:pass@www.tiktok.com/@creator/video/1',
    )

    expect(screen.getByText('视频链接不能包含账号信息')).toBeVisible()
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeDisabled()
    expect(backend.startJob).not.toHaveBeenCalled()
  })

  it('edits, copies, and exports transcript segments through the backend', async () => {
    const user = userEvent.setup()
    const clipboardWrite = vi.mocked(writeText)

    const { backend } = createBackend({
      listJobs: vi.fn(async () => [processingJob]),
    })
    render(<App backend={backend} />)

    const secondSegment = await screen.findByLabelText('第 2 段文案')
    await user.clear(secondSegment)
    await user.type(secondSegment, '修改后的第二段文案。')
    await user.click(screen.getByRole('button', { name: '复制文案' }))

    expect(clipboardWrite).toHaveBeenCalledWith(
      '这是一段正在本地处理的视频文案。\n修改后的第二段文案。',
    )

    await user.click(screen.getByRole('button', { name: '选择' }))
    await user.click(screen.getByRole('button', { name: /VTT.*网页字幕/ }))
    await user.click(screen.getByRole('button', { name: /导出 VTT/ }))

    expect(backend.exportTranscript).toHaveBeenCalledWith({
      jobId: 'job-1',
      exportFormat: 'vtt',
      segments: [
        processingJob.segments[0],
        { ...processingJob.segments[1], text: '修改后的第二段文案。' },
      ],
    })

    await user.click(screen.getByRole('button', { name: '打开文件位置' }))
    expect(backend.openOutputDirectory).toHaveBeenCalledWith('job-1')
  })

  it('deduplicates repeated job events and cancels an active job', async () => {
    const user = userEvent.setup()
    const fixture = createBackend()
    render(<App backend={fixture.backend} />)

    await screen.findByText('暂无任务')
    act(() => {
      fixture.emitJob(processingJob)
      fixture.emitJob(processingJob)
    })

    const taskTable = screen.getByRole('table')
    expect(within(taskTable).getAllByRole('row')).toHaveLength(2)
    expect(within(taskTable).getByText('68%')).toBeVisible()

    await user.click(within(taskTable).getByRole('button', { name: '取消' }))
    expect(fixture.backend.cancelJob).toHaveBeenCalledWith('job-1')
  })

  it('uses indeterminate progress instead of inventing a percentage', async () => {
    const unknownProgressJob: JobSnapshot = {
      ...processingJob,
      id: 'job-unknown-progress',
      stage: 'loading_model',
      stageProgress: null,
      overallProgress: null,
      message: '正在加载模型',
      segments: [],
    }
    const { backend } = createBackend({
      listJobs: vi.fn(async () => [unknownProgressJob]),
    })

    render(<App backend={backend} />)

    const taskTable = await screen.findByRole('table')
    expect(within(taskTable).getByText('处理中')).toBeVisible()
    expect(within(taskTable).queryByText(/%/)).not.toBeInTheDocument()
  })

  it('selects a file dropped through the Tauri drag event', async () => {
    const user = userEvent.setup()
    const fixture = createBackend()
    render(<App backend={fixture.backend} />)

    await screen.findByText('暂无任务')
    act(() => {
      fixture.emitFileDrop({
        type: 'drop',
        paths: ['C:\\Videos\\采访素材.mp4'],
      })
    })

    expect(screen.getByText('采访素材.mp4')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '选择' }))
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeEnabled()
  })

  it('keeps file selection usable when native drag subscription fails', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend({
      subscribeFileDrops: vi.fn(async () => {
        throw new Error('drag unavailable')
      }),
    })
    render(<App backend={backend} />)

    expect(
      await screen.findByText('文件拖放不可用，请点击选择视频或音频'),
    ).toBeVisible()
    await user.click(screen.getByTestId('media-drop-zone'))
    await user.click(screen.getByRole('button', { name: '选择' }))

    expect(backend.getAppInfo).toHaveBeenCalled()
    expect(backend.listJobs).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeEnabled()
  })
})

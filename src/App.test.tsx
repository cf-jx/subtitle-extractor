import { act, render, screen, waitFor, within } from '@testing-library/react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopBackend,
  FileDropEvent,
  JobSnapshot,
} from './backend/types'
import type { UpdateService } from './update/types'
import App from './App'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async () => undefined),
}))

const processingJob: JobSnapshot = {
  id: 'job-1',
  revision: 3,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
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
    exportTranscript: vi.fn(async (request) => ({
      ...processingJob,
      revision: processingJob.revision + 1,
      stage: 'completed' as const,
      stageProgress: 100,
      overallProgress: 100,
      segments: request.segments,
      message: '字幕已导出',
    })),
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
  it('offers an available update and relaunches after installation', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    const downloadAndInstall = vi.fn(async (onProgress) => {
      onProgress({ downloadedBytes: 50, totalBytes: 100 })
    })
    const updateService: UpdateService = {
      available: true,
      check: vi.fn(async () => ({
        currentVersion: '0.2.0',
        version: '0.2.1',
        notes: '修复字幕导出问题。',
        downloadAndInstall,
      })),
      relaunch: vi.fn(async () => undefined),
    }

    render(<App backend={backend} updateService={updateService} />)

    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(screen.getByText('0.2.0 → 0.2.1')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '立即更新' }))

    expect(downloadAndInstall).toHaveBeenCalledOnce()
    expect(updateService.relaunch).toHaveBeenCalledOnce()
    expect(screen.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
  })

  it('waits for the initial task state before offering an update', async () => {
    const jobsRequest = createDeferred<JobSnapshot[]>()
    const { backend } = createBackend({
      listJobs: vi.fn(() => jobsRequest.promise),
    })
    const updateService: UpdateService = {
      available: true,
      check: vi.fn(async () => ({
        currentVersion: '0.2.0',
        version: '0.2.1',
        notes: null,
        downloadAndInstall: vi.fn(async () => undefined),
      })),
      relaunch: vi.fn(async () => undefined),
    }

    render(<App backend={backend} updateService={updateService} />)

    expect(
      await screen.findByText(/新版本 0\.2\.1 已就绪，正在读取任务状态/),
    ).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    act(() => {
      jobsRequest.resolve([])
    })
    expect(await screen.findByRole('dialog')).toBeVisible()
  })

  it('keeps keyboard focus inside the update dialog and closes with Escape', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    const updateService: UpdateService = {
      available: true,
      check: vi.fn(async () => ({
        currentVersion: '0.2.0',
        version: '0.2.1',
        notes: null,
        downloadAndInstall: vi.fn(async () => undefined),
      })),
      relaunch: vi.fn(async () => undefined),
    }

    render(<App backend={backend} updateService={updateService} />)

    const installButton = await screen.findByRole('button', {
      name: '立即更新',
    })
    expect(installButton).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '稍后更新' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('defers an available update until active jobs finish', async () => {
    const fixture = createBackend({
      listJobs: vi.fn(async () => [processingJob]),
    })
    const update = {
      currentVersion: '0.2.0',
      version: '0.2.1',
      notes: null,
      downloadAndInstall: vi.fn(async () => undefined),
    }
    const updateService: UpdateService = {
      available: true,
      check: vi.fn(async () => update),
      relaunch: vi.fn(async () => undefined),
    }

    render(<App backend={fixture.backend} updateService={updateService} />)

    expect(
      await screen.findByText(/新版本 0\.2\.1 已就绪，当前任务完成后即可更新/),
    ).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    act(() => {
      fixture.emitJob({
        ...processingJob,
        revision: processingJob.revision + 1,
        stage: 'completed',
        stageProgress: 100,
        overallProgress: 100,
        message: '字幕提取完成',
      })
    })

    expect(await screen.findByRole('dialog')).toBeVisible()
  })

  it('defers an available update until edited subtitles are exported', async () => {
    const user = userEvent.setup()
    const completedJob: JobSnapshot = {
      ...processingJob,
      revision: 4,
      stage: 'completed',
      stageProgress: 100,
      overallProgress: 100,
      message: '字幕提取完成',
    }
    const { backend } = createBackend({
      listJobs: vi.fn(async () => [completedJob]),
    })
    let resolveUpdate:
      | ((update: Awaited<ReturnType<UpdateService['check']>>) => void)
      | undefined
    const updateService: UpdateService = {
      available: true,
      check: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<UpdateService['check']>>>((resolve) => {
            resolveUpdate = resolve
          }),
      ),
      relaunch: vi.fn(async () => undefined),
    }
    const update = {
      currentVersion: '0.2.0',
      version: '0.2.1',
      notes: null,
      downloadAndInstall: vi.fn(async () => undefined),
    }

    render(<App backend={backend} updateService={updateService} />)

    const firstSegment = await screen.findByLabelText('第 1 段文案')
    await user.clear(firstSegment)
    await user.type(firstSegment, '修改后的第一段文案。')
    act(() => resolveUpdate?.(update))

    expect(
      await screen.findByText(/请先导出已修改的字幕，再更新/),
    ).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /导出 TXT/ }))
    expect(await screen.findByRole('dialog')).toBeVisible()
  })

  it('lets the user retry app initialization without losing other features', async () => {
    const user = userEvent.setup()
    const getAppInfo = vi
      .fn<DesktopBackend['getAppInfo']>()
      .mockRejectedValueOnce(new Error('model check failed'))
      .mockResolvedValue({
        platform: 'macos',
        modelName: 'Whisper Small',
        modelReady: true,
      })
    const { backend } = createBackend({ getAppInfo })

    render(<App backend={backend} />)

    expect(await screen.findByText(/字幕组件初始化失败/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(
      await screen.findByRole('button', {
        name: /开始提取.*请选择视频或音频文件/,
      }),
    ).toBeVisible()
    expect(getAppInfo).toHaveBeenCalledTimes(2)
  })

  it('keeps extraction available when loading the task list fails', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend({
      listJobs: vi.fn(async () => {
        throw new Error('task list failed')
      }),
    })

    render(<App backend={backend} />)

    expect(await screen.findByText('task list failed')).toBeVisible()
    await user.click(screen.getByTestId('media-drop-zone'))
    await user.click(screen.getByRole('button', { name: '选择' }))
    expect(screen.getByRole('button', { name: /开始提取/ })).toBeEnabled()
  })

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

    expect(await screen.findByText(/缺少本地字幕模型/)).toBeVisible()
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
      includeTimestamps: true,
    })
  })

  it('keeps timestamp selection independent from the export format', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    render(<App backend={backend} />)

    await screen.findByText('暂无任务')
    await user.click(screen.getByTestId('media-drop-zone'))
    await user.click(screen.getByRole('button', { name: '选择' }))
    await user.click(
      screen.getByRole('switch', { name: '保留时间轴' }),
    )
    await user.click(screen.getByRole('button', { name: /开始提取/ }))

    expect(backend.startJob).toHaveBeenCalledWith({
      sourceKind: 'local',
      source: '/Users/tester/Videos/示例视频.mp4',
      outputDir: '/Users/tester/Documents/文案输出',
      exportFormat: 'txt',
      includeTimestamps: false,
    })
  })

  it('rejects unsupported URLs before invoking the backend', async () => {
    const user = userEvent.setup()
    const { backend } = createBackend()
    render(<App backend={backend} />)

    await screen.findByText('暂无任务')
    await user.click(screen.getByRole('button', { name: '视频链接' }))
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
    await user.click(screen.getByRole('button', { name: '视频链接' }))
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
    const completedJob: JobSnapshot = {
      ...processingJob,
      revision: 4,
      stage: 'completed',
      stageProgress: 100,
      overallProgress: 100,
      message: '字幕提取完成',
    }
    const editedSegments = [
      completedJob.segments[0],
      { ...completedJob.segments[1], text: '修改后的第二段文案。' },
    ]
    const persistedJob: JobSnapshot = {
      ...completedJob,
      revision: 5,
      segments: editedSegments,
      message: '字幕已导出',
    }

    const { backend } = createBackend({
      listJobs: vi.fn(async () => [completedJob]),
      exportTranscript: vi.fn(async () => persistedJob),
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
      includeTimestamps: true,
      segments: editedSegments,
    })
    await waitFor(() => {
      expect(screen.getByLabelText('第 2 段文案')).toHaveValue(
        '修改后的第二段文案。',
      )
    })

    await user.click(screen.getByRole('button', { name: '打开文件位置' }))
    expect(backend.openOutputDirectory).toHaveBeenCalledWith('job-1')
  })

  it('locks transcript editing while an export is pending', async () => {
    const user = userEvent.setup()
    const exportRequest = createDeferred<JobSnapshot>()
    const completedJob: JobSnapshot = {
      ...processingJob,
      revision: 4,
      stage: 'completed',
      stageProgress: 100,
      overallProgress: 100,
      message: '字幕提取完成',
    }
    const editedSegments = completedJob.segments.map((segment, index) =>
      index === 0 ? { ...segment, text: '导出中的已修改文案。' } : segment,
    )
    const persistedJob: JobSnapshot = {
      ...completedJob,
      revision: 5,
      segments: editedSegments,
      message: '字幕已导出',
    }
    const { backend } = createBackend({
      listJobs: vi.fn(async () => [completedJob]),
      exportTranscript: vi.fn(() => exportRequest.promise),
    })

    render(<App backend={backend} />)

    const firstSegment = await screen.findByLabelText('第 1 段文案')
    await user.clear(firstSegment)
    await user.type(firstSegment, '导出中的已修改文案。')
    await user.click(screen.getByRole('button', { name: /导出 TXT/ }))

    expect(firstSegment).toBeDisabled()
    act(() => {
      exportRequest.resolve(persistedJob)
    })
    await waitFor(() => {
      expect(screen.getByLabelText('第 1 段文案')).toBeEnabled()
      expect(screen.getByLabelText('第 1 段文案')).toHaveValue(
        '导出中的已修改文案。',
      )
    })
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

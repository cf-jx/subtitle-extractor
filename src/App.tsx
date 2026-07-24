import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Info, ShieldCheck, X } from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type {
  AppInfo,
  DesktopBackend,
  ExportFormat,
  JobSnapshot,
  SourceKind,
  SubtitleSegment,
  Unlisten,
} from './backend/types'
import { tauriBackend } from './backend/tauriBackend'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { SettingsDialog } from './components/SettingsDialog'
import { SourcePanel } from './components/SourcePanel'
import { TaskQueue } from './components/TaskQueue'
import { TranscriptPanel } from './components/TranscriptPanel'
import {
  transcriptToPlainText,
  terminalStages,
  upsertJob,
  validateVideoUrl,
} from './lib/transcript'
import './App.css'

interface AppProps {
  backend?: DesktopBackend
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function selectedSource(
  sourceKind: SourceKind,
  localPath: string,
  url: string,
): string {
  return sourceKind === 'local' ? localPath : url.trim()
}

function mergeJobList(
  current: JobSnapshot[],
  snapshots: JobSnapshot[],
): JobSnapshot[] {
  return snapshots.reduce(upsertJob, current)
}

function App({ backend = tauriBackend }: AppProps) {
  const [view, setView] = useState<AppView>('new')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceKind, setSourceKind] = useState<SourceKind>('local')
  const [localPath, setLocalPath] = useState('')
  const [url, setUrl] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt')
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [segmentEdits, setSegmentEdits] = useState<
    Record<string, SubtitleSegment[]>
  >({})
  const [isStarting, setIsStarting] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isOpeningOutput, setIsOpeningOutput] = useState(false)
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const urlError = useMemo(
    () => (url.trim() === '' ? null : validateVideoUrl(url)),
    [url],
  )

  const source = selectedSource(sourceKind, localPath, url)
  const modelReady = appInfo?.modelReady === true
  const sourceIsProcessing = jobs.some(
    (job) =>
      job.sourceKind === sourceKind &&
      job.source === source &&
      !terminalStages.has(job.stage),
  )
  const canStart =
    backend.availability.available &&
    modelReady &&
    source !== '' &&
    outputDir !== '' &&
    (sourceKind === 'local' || urlError === null) &&
    !sourceIsProcessing

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  )

  const selectedSegments = useMemo(() => {
    if (!selectedJob) {
      return []
    }
    return segmentEdits[selectedJob.id] ?? selectedJob.segments
  }, [segmentEdits, selectedJob])

  const showError = useCallback((error: unknown) => {
    setSuccessMessage(null)
    setOperationError(messageFromError(error))
  }, [])

  const refreshJobs = useCallback(async () => {
    const snapshots = await backend.listJobs()
    setJobs((current) => mergeJobList(current, snapshots))
    setSelectedJobId((current) => {
      if (current && snapshots.some((job) => job.id === current)) {
        return current
      }
      return snapshots.find((job) => job.segments.length > 0)?.id ?? null
    })
  }, [backend])

  useEffect(() => {
    if (!backend.availability.available) {
      return
    }

    let disposed = false
    const activeUnlisteners: Unlisten[] = []

    const initialize = async () => {
      try {
        const unlistenJobs = await backend.subscribeJobUpdates((snapshot) => {
          if (disposed) {
            return
          }
          setJobs((current) => upsertJob(current, snapshot))
          if (snapshot.segments.length > 0) {
            setSelectedJobId((current) => current ?? snapshot.id)
          }
        })
        if (disposed) {
          unlistenJobs()
          return
        }
        activeUnlisteners.push(unlistenJobs)

        try {
          const unlistenDrops = await backend.subscribeFileDrops((event) => {
            if (disposed) {
              return
            }
            setIsDragging(event.type === 'enter' || event.type === 'over')
            if (event.type === 'drop' && event.paths[0]) {
              setSourceKind('local')
              setLocalPath(event.paths[0])
              setOperationError(null)
            }
          })
          if (disposed) {
            unlistenDrops()
          } else {
            activeUnlisteners.push(unlistenDrops)
          }
        } catch {
          if (!disposed) {
            setOperationError('文件拖放不可用，请点击选择视频或音频')
          }
        }

        const [info] = await Promise.all([backend.getAppInfo(), refreshJobs()])
        if (!disposed) {
          setAppInfo(info)
        }
      } catch (error) {
        if (!disposed) {
          showError(error)
        }
      }
    }

    void initialize()

    return () => {
      disposed = true
      for (const unlisten of activeUnlisteners) {
        unlisten()
      }
    }
  }, [backend, refreshJobs, showError])

  const handlePickMedia = useCallback(async () => {
    setOperationError(null)
    try {
      const path = await backend.pickMedia()
      if (path) {
        setSourceKind('local')
        setLocalPath(path)
      }
    } catch (error) {
      showError(error)
    }
  }, [backend, showError])

  const handlePickOutput = useCallback(async () => {
    setOperationError(null)
    try {
      const path = await backend.pickOutputDirectory()
      if (path) {
        setOutputDir(path)
      }
    } catch (error) {
      showError(error)
    }
  }, [backend, showError])

  const handleStart = useCallback(async () => {
    if (!canStart) {
      if (sourceKind === 'url') {
        setOperationError(validateVideoUrl(url))
      } else if (!localPath) {
        setOperationError('请选择一个视频或音频文件')
      } else if (!outputDir) {
        setOperationError('请选择字幕输出位置')
      }
      return
    }

    setIsStarting(true)
    setOperationError(null)
    setSuccessMessage(null)
    try {
      await backend.startJob({
        sourceKind,
        source,
        outputDir,
        exportFormat,
      })
      await refreshJobs()
    } catch (error) {
      showError(error)
    } finally {
      setIsStarting(false)
    }
  }, [
    backend,
    canStart,
    exportFormat,
    localPath,
    outputDir,
    refreshJobs,
    showError,
    source,
    sourceKind,
    url,
  ])

  const handleCancel = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId)
      setOperationError(null)
      try {
        await backend.cancelJob(jobId)
        await refreshJobs()
      } catch (error) {
        showError(error)
      } finally {
        setCancellingJobId(null)
      }
    },
    [backend, refreshJobs, showError],
  )

  const handleSegmentChange = useCallback(
    (index: number, text: string) => {
      if (!selectedJob) {
        return
      }

      setSegmentEdits((current) => {
        const existing = current[selectedJob.id] ?? selectedJob.segments
        return {
          ...current,
          [selectedJob.id]: existing.map((segment) =>
            segment.index === index ? { ...segment, text } : segment,
          ),
        }
      })
    },
    [selectedJob],
  )

  const handleCopy = useCallback(async () => {
    const plainText = transcriptToPlainText(selectedSegments)
    if (!plainText) {
      return
    }

    setIsCopying(true)
    setOperationError(null)
    try {
      await writeText(plainText)
      setSuccessMessage('文案已复制')
    } catch (error) {
      showError(error)
    } finally {
      setIsCopying(false)
    }
  }, [selectedSegments, showError])

  const handleExport = useCallback(async () => {
    if (!selectedJob || selectedSegments.length === 0) {
      setOperationError('请选择已完成的字幕任务')
      return
    }

    setIsExporting(true)
    setOperationError(null)
    try {
      await backend.exportTranscript({
        jobId: selectedJob.id,
        segments: selectedSegments,
        exportFormat,
      })
      setSuccessMessage(`${exportFormat.toUpperCase()} 已导出`)
      await refreshJobs()
    } catch (error) {
      showError(error)
    } finally {
      setIsExporting(false)
    }
  }, [
    backend,
    exportFormat,
    refreshJobs,
    selectedJob,
    selectedSegments,
    showError,
  ])

  const handleOpenOutput = useCallback(async () => {
    if (!selectedJob) {
      setOperationError('请选择一个任务')
      return
    }

    setIsOpeningOutput(true)
    setOperationError(null)
    try {
      await backend.openOutputDirectory(selectedJob.id)
    } catch (error) {
      showError(error)
    } finally {
      setIsOpeningOutput(false)
    }
  }, [backend, selectedJob, showError])

  const selectJob = useCallback((jobId: string) => {
    setSelectedJobId(jobId)
    setView('new')
  }, [])

  const modelName = appInfo?.modelName || 'Whisper Small'

  return (
    <div className="app-shell">
      <AppSidebar
        currentView={view}
        onViewChange={setView}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="app-main">
        <header className="app-toolbar">
          <span className="local-processing">
            <ShieldCheck aria-hidden="true" />
            仅在本机处理
          </span>
          <label className="model-select">
            <span className="visually-hidden">识别模型</span>
            <select value={modelName} disabled>
              <option>{modelName}</option>
            </select>
          </label>
        </header>

        <main className="app-content">
          {view === 'new' ? (
            <>
              <div className="page-heading">
                <h1>提取视频文案</h1>
                {!backend.availability.available ? (
                  <div className="runtime-notice" role="status">
                    <Info aria-hidden="true" />
                    <span>{backend.availability.reason}</span>
                  </div>
                ) : appInfo?.modelReady === false ? (
                  <div className="runtime-notice model-warning" role="alert">
                    <Info aria-hidden="true" />
                    <span>缺少本地字幕模型</span>
                  </div>
                ) : null}
              </div>

              {operationError ? (
                <div className="feedback-banner error" role="alert">
                  <span>{operationError}</span>
                  <button
                    type="button"
                    aria-label="关闭错误提示"
                    onClick={() => setOperationError(null)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {successMessage ? (
                <div className="feedback-banner success" role="status">
                  <CheckCircle2 aria-hidden="true" />
                  <span>{successMessage}</span>
                  <button
                    type="button"
                    aria-label="关闭成功提示"
                    onClick={() => setSuccessMessage(null)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}

              <div className="workspace-grid">
                <SourcePanel
                  sourceKind={sourceKind}
                  localPath={localPath}
                  url={url}
                  outputDir={outputDir}
                  exportFormat={exportFormat}
                  urlError={urlError}
                  isStarting={isStarting || sourceIsProcessing}
                  isDragging={isDragging}
                  runtimeAvailable={backend.availability.available}
                  canStart={canStart}
                  onSourceKindChange={setSourceKind}
                  onUrlChange={setUrl}
                  onPickMedia={() => void handlePickMedia()}
                  onPickOutput={() => void handlePickOutput()}
                  onExportFormatChange={setExportFormat}
                  onStart={() => void handleStart()}
                  onDomDragEnter={() => setIsDragging(true)}
                  onDomDragLeave={() => setIsDragging(false)}
                />
                <TranscriptPanel
                  job={selectedJob}
                  segments={selectedSegments}
                  runtimeAvailable={backend.availability.available}
                  isCopying={isCopying}
                  isExporting={isExporting}
                  isOpeningOutput={isOpeningOutput}
                  exportFormat={exportFormat}
                  onSegmentChange={handleSegmentChange}
                  onCopy={() => void handleCopy()}
                  onExport={() => void handleExport()}
                  onOpenOutput={() => void handleOpenOutput()}
                />
              </div>

              <TaskQueue
                jobs={jobs}
                selectedJobId={selectedJobId}
                cancellingJobId={cancellingJobId}
                onSelect={setSelectedJobId}
                onCancel={(jobId) => void handleCancel(jobId)}
              />
            </>
          ) : (
            <section className="history-view">
              <div className="page-heading">
                <h1>本次任务</h1>
              </div>
              {operationError ? (
                <div className="feedback-banner error" role="alert">
                  <span>{operationError}</span>
                  <button
                    type="button"
                    aria-label="关闭错误提示"
                    onClick={() => setOperationError(null)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <TaskQueue
                jobs={jobs}
                selectedJobId={selectedJobId}
                cancellingJobId={cancellingJobId}
                onSelect={selectJob}
                onCancel={(jobId) => void handleCancel(jobId)}
              />
            </section>
          )}
        </main>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

export default App

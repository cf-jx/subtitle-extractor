import {
  Clipboard,
  Download,
  FileText,
  FolderOpen,
  LoaderCircle,
} from 'lucide-react'
import type {
  ExportFormat,
  JobSnapshot,
  SubtitleSegment,
} from '../backend/types'
import { formatTimestamp } from '../lib/transcript'

interface TranscriptPanelProps {
  job: JobSnapshot | null
  segments: SubtitleSegment[]
  runtimeAvailable: boolean
  isCopying: boolean
  isExporting: boolean
  isOpeningOutput: boolean
  exportFormat: ExportFormat
  onSegmentChange: (index: number, text: string) => void
  onCopy: () => void
  onExport: () => void
  onOpenOutput: () => void
}

export function TranscriptPanel({
  job,
  segments,
  runtimeAvailable,
  isCopying,
  isExporting,
  isOpeningOutput,
  exportFormat,
  onSegmentChange,
  onCopy,
  onExport,
  onOpenOutput,
}: TranscriptPanelProps) {
  const hasTranscript = segments.length > 0
  const canExport =
    runtimeAvailable && hasTranscript && job?.stage === 'completed'

  return (
    <section
      className="panel transcript-panel"
      aria-labelledby="transcript-title"
    >
      <header className="panel-header transcript-header">
        <div>
          <h2 id="transcript-title">字幕预览</h2>
          {job ? <span className="selected-task-name">{job.displayName}</span> : null}
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!job || !runtimeAvailable || isOpeningOutput}
            onClick={onOpenOutput}
          >
            {isOpeningOutput ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <FolderOpen aria-hidden="true" />
            )}
            打开文件位置
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!hasTranscript || isCopying}
            onClick={onCopy}
          >
            {isCopying ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <Clipboard aria-hidden="true" />
            )}
            复制文案
          </button>
          <button
            type="button"
            className="secondary-button export-button"
            disabled={!canExport || isExporting}
            onClick={onExport}
          >
            {isExporting ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            导出 {exportFormat.toUpperCase()}
          </button>
        </div>
      </header>

      {hasTranscript ? (
        <div className="transcript-content">
          <div className="transcript-columns" aria-hidden="true">
            <span />
            <span>时间戳</span>
            <span>文案内容</span>
          </div>
          <ol className="segment-list" aria-label="字幕片段">
            {segments.map((segment, position) => (
              <li className="segment-row" key={segment.index}>
                <span className="segment-number">{position + 1}</span>
                <time>
                  {formatTimestamp(segment.startMs)}
                  <span aria-hidden="true"> → </span>
                  {formatTimestamp(segment.endMs)}
                </time>
                <textarea
                  value={segment.text}
                  aria-label={`第 ${position + 1} 段文案`}
                  disabled={isExporting}
                  onChange={(event) =>
                    onSegmentChange(segment.index, event.target.value)
                  }
                />
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="transcript-empty">
          <span className="empty-document" aria-hidden="true">
            <FileText />
          </span>
          <p>完成后，字幕会显示在这里</p>
          {job?.error || job?.message ? (
            <span className="empty-detail">{job.error || job.message}</span>
          ) : null}
        </div>
      )}
    </section>
  )
}

import {
  CheckCircle2,
  Clock3,
  FileVideo2,
  Folder,
  Link2,
  LoaderCircle,
  PawPrint,
} from 'lucide-react'
import type { ExportFormat, SourceKind } from '../backend/types'
import { filenameFromPath } from '../lib/transcript'

interface SourcePanelProps {
  sourceKind: SourceKind
  localPath: string
  url: string
  outputDir: string
  exportFormat: ExportFormat
  includeTimestamps: boolean
  urlError: string | null
  isStarting: boolean
  isDragging: boolean
  runtimeAvailable: boolean
  canStart: boolean
  startBlockReason: string | null
  onSourceKindChange: (sourceKind: SourceKind) => void
  onUrlChange: (value: string) => void
  onPickMedia: () => void
  onPickOutput: () => void
  onExportFormatChange: (format: ExportFormat) => void
  onIncludeTimestampsChange: (include: boolean) => void
  onStart: () => void
  onDomDragEnter: () => void
  onDomDragLeave: () => void
}

export function SourcePanel({
  sourceKind,
  localPath,
  url,
  outputDir,
  exportFormat,
  includeTimestamps,
  urlError,
  isStarting,
  isDragging,
  runtimeAvailable,
  canStart,
  startBlockReason,
  onSourceKindChange,
  onUrlChange,
  onPickMedia,
  onPickOutput,
  onExportFormatChange,
  onIncludeTimestampsChange,
  onStart,
  onDomDragEnter,
  onDomDragLeave,
}: SourcePanelProps) {
  const hasValidUrl = sourceKind === 'url' && url !== '' && urlError === null

  return (
    <section className="panel source-panel" aria-labelledby="source-title">
      <header className="source-heading">
        <FileVideo2 aria-hidden="true" />
        <h2 id="source-title">视频来源</h2>
      </header>

      <div className="source-tabs" role="group" aria-label="视频来源">
        <button
          type="button"
          aria-pressed={sourceKind === 'local'}
          className="source-tab"
          onClick={() => onSourceKindChange('local')}
        >
          本地视频
        </button>
        <button
          type="button"
          aria-pressed={sourceKind === 'url'}
          className="source-tab"
          onClick={() => onSourceKindChange('url')}
        >
          视频链接
        </button>
      </div>

      <div className="source-body">
        {sourceKind === 'local' ? (
          <button
            type="button"
            className={`drop-zone${isDragging ? ' is-dragging' : ''}${
              localPath ? ' has-file' : ''
            }`}
            disabled={!runtimeAvailable}
            onClick={onPickMedia}
            onDragEnter={onDomDragEnter}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={onDomDragLeave}
            data-testid="media-drop-zone"
          >
            <span className="drop-icon" aria-hidden="true">
              {localPath ? (
                <CheckCircle2 size={32} />
              ) : (
                <FileVideo2 size={38} />
              )}
            </span>
            <strong>
              {localPath ? filenameFromPath(localPath) : '拖入视频，或点击选择'}
            </strong>
            <span>
              {localPath ? '点击可重新选择' : '支持常见视频与音频格式'}
            </span>
          </button>
        ) : (
          <div className="url-source">
            <label htmlFor="video-url">视频链接</label>
            <div
              className={`url-field${hasValidUrl ? ' is-valid' : ''}${
                urlError && url ? ' is-invalid' : ''
              }`}
            >
              <Link2 aria-hidden="true" />
              <input
                id="video-url"
                type="url"
                inputMode="url"
                value={url}
                aria-invalid={Boolean(urlError && url)}
                aria-describedby="video-url-help"
                placeholder="粘贴抖音或 TikTok 视频链接"
                onChange={(event) => onUrlChange(event.target.value)}
              />
              {hasValidUrl ? (
                <CheckCircle2
                  className="field-valid-icon"
                  aria-label="链接有效"
                />
              ) : null}
            </div>
            <p
              id="video-url-help"
              className={`field-help${urlError && url ? ' is-error' : ''}`}
            >
              {urlError && url
                ? urlError
                : '支持不登录也能播放的抖音与 TikTok 单个视频'}
            </p>
          </div>
        )}

        <div className="output-field">
          <label htmlFor="output-directory">输出位置</label>
          <div className="path-picker">
            <input
              id="output-directory"
              type="text"
              value={outputDir}
              placeholder="请选择字幕保存文件夹"
              readOnly
            />
            <button
              type="button"
              className="secondary-button"
              disabled={!runtimeAvailable}
              onClick={onPickOutput}
            >
              <Folder aria-hidden="true" />
              选择
            </button>
          </div>
        </div>

        <fieldset className="format-field">
          <legend>导出格式</legend>
          <div className="format-options">
            {(['txt', 'srt', 'vtt'] as const).map((format) => (
              <button
                type="button"
                className="format-option"
                aria-pressed={exportFormat === format}
                key={format}
                onClick={() => onExportFormatChange(format)}
              >
                <strong>{format.toUpperCase()}</strong>
                <span>
                  {format === 'txt'
                    ? '文本文档'
                    : format === 'srt'
                      ? '通用字幕'
                      : '网页字幕'}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="timeline-field">
          <div className="timeline-copy">
            <Clock3 aria-hidden="true" />
            <span>
              <strong>保留时间轴</strong>
              <small>
                {exportFormat === 'txt'
                  ? '关闭后仅导出文案内容'
                  : '字幕格式按标准始终保留时间轴'}
              </small>
            </span>
          </div>
          <button
            type="button"
            className="timeline-switch"
            role="switch"
            aria-label="保留时间轴"
            aria-checked={
              exportFormat === 'txt' ? includeTimestamps : true
            }
            disabled={exportFormat !== 'txt'}
            onClick={() => onIncludeTimestampsChange(!includeTimestamps)}
          >
            <span aria-hidden="true" />
          </button>
        </div>

      </div>
      <button
        type="button"
        className={`primary-button start-button${
          startBlockReason ? ' has-reason' : ''
        }`}
        title={startBlockReason || undefined}
        disabled={!canStart || isStarting}
        onClick={onStart}
      >
        {isStarting ? (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            正在处理
          </>
        ) : (
          <>
            <PawPrint aria-hidden="true" />
            <span>
              {startBlockReason
                ? `开始提取 · ${startBlockReason}`
                : '开始提取'}
            </span>
          </>
        )}
      </button>
    </section>
  )
}

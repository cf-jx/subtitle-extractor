import {
  CheckCircle2,
  FileVideo2,
  Folder,
  Link2,
  LoaderCircle,
  Upload,
} from 'lucide-react'
import type { SourceKind } from '../backend/types'
import { filenameFromPath } from '../lib/transcript'

interface SourcePanelProps {
  sourceKind: SourceKind
  localPath: string
  url: string
  outputDir: string
  urlError: string | null
  isStarting: boolean
  isDragging: boolean
  runtimeAvailable: boolean
  canStart: boolean
  onSourceKindChange: (sourceKind: SourceKind) => void
  onUrlChange: (value: string) => void
  onPickMedia: () => void
  onPickOutput: () => void
  onStart: () => void
  onDomDragEnter: () => void
  onDomDragLeave: () => void
}

export function SourcePanel({
  sourceKind,
  localPath,
  url,
  outputDir,
  urlError,
  isStarting,
  isDragging,
  runtimeAvailable,
  canStart,
  onSourceKindChange,
  onUrlChange,
  onPickMedia,
  onPickOutput,
  onStart,
  onDomDragEnter,
  onDomDragLeave,
}: SourcePanelProps) {
  const hasValidUrl = sourceKind === 'url' && url !== '' && urlError === null

  return (
    <section className="panel source-panel" aria-labelledby="source-title">
      <h2 id="source-title" className="visually-hidden">
        视频来源
      </h2>

      <div className="source-tabs" role="tablist" aria-label="视频来源">
        <button
          type="button"
          role="tab"
          aria-selected={sourceKind === 'local'}
          className="source-tab"
          onClick={() => onSourceKindChange('local')}
        >
          本地视频
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceKind === 'url'}
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

        <button
          type="button"
          className="primary-button start-button"
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
              <Upload aria-hidden="true" />
              开始提取
            </>
          )}
        </button>
      </div>
    </section>
  )
}

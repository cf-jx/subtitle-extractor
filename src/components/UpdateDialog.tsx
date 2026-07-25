import { Download, RefreshCw, X } from 'lucide-react'
import type { AvailableUpdate, UpdateProgress } from '../update/types'

interface UpdateDialogProps {
  update: AvailableUpdate
  status: 'available' | 'downloading' | 'failed'
  progress: UpdateProgress
  error: string | null
  onInstall: () => void
  onDismiss: () => void
}

function formatProgress(progress: UpdateProgress): string {
  if (progress.totalBytes === null || progress.totalBytes <= 0) {
    const megabytes = progress.downloadedBytes / 1024 / 1024
    return `已下载 ${megabytes.toFixed(1)} MB`
  }

  const percent = Math.min(
    100,
    Math.round((progress.downloadedBytes / progress.totalBytes) * 100),
  )
  return `${percent}%`
}

export function UpdateDialog({
  update,
  status,
  progress,
  error,
  onInstall,
  onDismiss,
}: UpdateDialogProps) {
  const isDownloading = status === 'downloading'
  const progressText = formatProgress(progress)
  const progressPercent =
    progress.totalBytes && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round(
            (progress.downloadedBytes / progress.totalBytes) * 100,
          ),
        )
      : null

  return (
    <div className="update-backdrop" role="presentation">
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
      >
        <div className="update-dialog-heading">
          <div className="update-mark" aria-hidden="true">
            <Download />
          </div>
          <div>
            <h2 id="update-title">发现新版本</h2>
            <p>
              {update.currentVersion} → {update.version}
            </p>
          </div>
          {!isDownloading ? (
            <button
              className="update-close"
              type="button"
              aria-label="稍后更新"
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {update.notes ? (
          <p className="update-notes">{update.notes}</p>
        ) : (
          <p className="update-notes">新版本包含功能改进和问题修复。</p>
        )}

        {isDownloading ? (
          <div className="update-progress" role="status" aria-live="polite">
            <div>
              <span>正在下载更新</span>
              <strong>{progressText}</strong>
            </div>
            <div className="update-progress-track" aria-hidden="true">
              <span
                className={progressPercent === null ? 'indeterminate' : ''}
                style={
                  progressPercent === null
                    ? undefined
                    : { width: `${progressPercent}%` }
                }
              />
            </div>
          </div>
        ) : null}

        {status === 'failed' ? (
          <p className="update-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="update-actions">
          {!isDownloading ? (
            <button
              className="button-secondary"
              type="button"
              onClick={onDismiss}
            >
              稍后
            </button>
          ) : null}
          <button
            className="button-primary update-install"
            type="button"
            disabled={isDownloading}
            onClick={onInstall}
          >
            {status === 'failed' ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            {isDownloading
              ? '安装完成后将自动重启'
              : status === 'failed'
                ? '重新下载'
                : '立即更新'}
          </button>
        </div>
      </section>
    </div>
  )
}

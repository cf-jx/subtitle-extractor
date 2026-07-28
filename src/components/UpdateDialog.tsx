import { useEffect, useRef } from 'react'
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
  const dialogRef = useRef<HTMLElement>(null)
  const installButtonRef = useRef<HTMLButtonElement>(null)
  const isDownloadingRef = useRef(isDownloading)
  isDownloadingRef.current = isDownloading
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

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const dialog = dialogRef.current
    installButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dialog) {
        return
      }
      if (event.key === 'Escape' && !isDownloadingRef.current) {
        event.preventDefault()
        onDismiss()
        return
      }
      if (event.key !== 'Tab') {
        return
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onDismiss])

  return (
    <div className="update-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="update-dialog"
        role="dialog"
        tabIndex={-1}
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
          <div className="update-progress">
            <div role="status" aria-live="polite">
              <span>正在下载更新</span>
              <strong>{progressText}</strong>
            </div>
            <div
              className="update-progress-track"
              role="progressbar"
              aria-label="更新下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent ?? undefined}
            >
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
            ref={installButtonRef}
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

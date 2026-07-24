import { useEffect } from 'react'
import { CheckCircle2, ShieldCheck, X } from 'lucide-react'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="settings-title">设置</h2>
            <p>识别在本机完成，视频不会上传到服务器。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭设置"
            autoFocus
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-section">
          <label htmlFor="settings-model">识别模型</label>
          <select id="settings-model" defaultValue="small">
            <option value="small">Whisper Small</option>
          </select>
          <span>适合中文、英文和中英混合视频。</span>
        </div>

        <div className="privacy-summary">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>仅在本机处理</strong>
            <span>音视频、识别结果和导出文件保留在当前电脑。</span>
          </div>
          <CheckCircle2 aria-hidden="true" />
        </div>
      </section>
    </div>
  )
}

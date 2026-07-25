import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import {
  previewBackend,
  previewDraft,
  previewUpdateService,
} from './backend/previewBackend.ts'

document.documentElement.lang = 'zh-CN'
document.title = '文案提取'

const previewParams = new URLSearchParams(window.location.search)
const showPreview = import.meta.env.DEV && previewParams.get('preview') === '1'
const showUpdatePreview = showPreview && previewParams.get('update') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      backend={showPreview ? previewBackend : undefined}
      updateService={showUpdatePreview ? previewUpdateService : undefined}
      initialDraft={showPreview ? previewDraft : undefined}
    />
  </StrictMode>,
)

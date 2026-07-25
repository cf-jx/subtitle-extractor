import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { previewBackend, previewDraft } from './backend/previewBackend.ts'

document.documentElement.lang = 'zh-CN'
document.title = '文案提取'

const showPreview =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('preview') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      backend={showPreview ? previewBackend : undefined}
      initialDraft={showPreview ? previewDraft : undefined}
    />
  </StrictMode>,
)

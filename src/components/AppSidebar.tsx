import {
  AudioLines,
  FilePlus2,
  History,
  PanelLeftClose,
  Settings,
} from 'lucide-react'

export type AppView = 'new' | 'history'

interface AppSidebarProps {
  currentView: AppView
  onViewChange: (view: AppView) => void
  onOpenSettings: () => void
}

export function AppSidebar({
  currentView,
  onViewChange,
  onOpenSettings,
}: AppSidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <AudioLines size={26} strokeWidth={2.4} />
        </span>
        <span>文案提取</span>
      </div>

      <nav className="primary-nav" aria-label="主导航">
        <button
          type="button"
          className="nav-item"
          aria-current={currentView === 'new' ? 'page' : undefined}
          onClick={() => onViewChange('new')}
        >
          <FilePlus2 aria-hidden="true" />
          <span>新建任务</span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-current={currentView === 'history' ? 'page' : undefined}
          onClick={() => onViewChange('history')}
        >
          <History aria-hidden="true" />
          <span>本次任务</span>
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={onOpenSettings}
        >
          <Settings aria-hidden="true" />
          <span>设置</span>
        </button>
      </nav>

      <div className="sidebar-footer" aria-hidden="true">
        <PanelLeftClose size={19} />
      </div>
    </aside>
  )
}

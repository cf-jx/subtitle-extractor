import {
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  FileVideo2,
  LoaderCircle,
  OctagonX,
  X,
} from 'lucide-react'
import type { JobSnapshot, JobStage } from '../backend/types'
import {
  isJobActive,
  normalizeProgress,
  terminalStages,
} from '../lib/transcript'

interface TaskQueueProps {
  jobs: JobSnapshot[]
  selectedJobId: string | null
  cancellingJobId: string | null
  onSelect: (jobId: string) => void
  onCancel: (jobId: string) => void
}

const stageLabels: Record<JobStage, string> = {
  queued: '等待处理',
  resolving_url: '解析链接',
  downloading: '下载视频',
  probing_media: '读取媒体',
  extracting_audio: '提取音频',
  loading_model: '加载模型',
  transcribing: '识别字幕',
  exporting: '生成文件',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const processingSteps = ['下载视频', '提取音频', '识别字幕', '生成文件']

function activeStepFor(job: JobSnapshot): number {
  switch (job.stage) {
    case 'queued':
    case 'resolving_url':
    case 'downloading':
      return 0
    case 'probing_media':
    case 'extracting_audio':
      return 1
    case 'loading_model':
    case 'transcribing':
      return 2
    case 'exporting':
    case 'completed':
      return 3
    case 'failed':
    case 'cancelled':
      return Math.max(
        0,
        Math.min(3, Math.floor((job.overallProgress ?? 0) / 25)),
      )
  }
}

function statusTone(stage: JobStage): string {
  if (stage === 'completed') {
    return 'success'
  }
  if (stage === 'failed') {
    return 'danger'
  }
  if (stage === 'cancelled') {
    return 'muted'
  }
  return 'active'
}

function formatCreatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function StageRail({ job }: { job: JobSnapshot }) {
  const activeStep = activeStepFor(job)
  const isComplete = job.stage === 'completed'

  return (
    <div className="stage-rail" aria-label={`当前阶段：${stageLabels[job.stage]}`}>
      {processingSteps.map((label, index) => {
        const complete = isComplete || index < activeStep
        const active = !terminalStages.has(job.stage) && index === activeStep
        return (
          <span
            className={`stage-step${complete ? ' is-complete' : ''}${
              active ? ' is-active' : ''
            }`}
            key={label}
          >
            <span className="stage-dot" aria-hidden="true">
              {complete ? <Check /> : active ? <Circle /> : null}
            </span>
            <span>{label}</span>
          </span>
        )
      })}
    </div>
  )
}

function StatusIcon({ stage }: { stage: JobStage }) {
  if (stage === 'completed') {
    return <CheckCircle2 aria-hidden="true" />
  }
  if (stage === 'failed') {
    return <CircleAlert aria-hidden="true" />
  }
  if (stage === 'cancelled') {
    return <OctagonX aria-hidden="true" />
  }
  return <LoaderCircle className="spin" aria-hidden="true" />
}

export function TaskQueue({
  jobs,
  selectedJobId,
  cancellingJobId,
  onSelect,
  onCancel,
}: TaskQueueProps) {
  const sortedJobs = jobs.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )

  return (
    <section className="panel task-panel" aria-labelledby="task-queue-title">
      <header className="panel-header task-header">
        <h2 id="task-queue-title">
          任务队列
          <span className="task-count">{jobs.length}</span>
        </h2>
      </header>

      {sortedJobs.length === 0 ? (
        <div className="task-empty">
          <FileVideo2 aria-hidden="true" />
          <span>暂无任务</span>
        </div>
      ) : (
        <div className="task-table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th>进度</th>
                <th>状态</th>
                <th>阶段</th>
                <th>操作</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => {
                const progress = normalizeProgress(job.overallProgress)
                const active = isJobActive(job.stage)
                const tone = statusTone(job.stage)
                return (
                  <tr
                    key={job.id}
                    className={selectedJobId === job.id ? 'is-selected' : ''}
                    onClick={() => onSelect(job.id)}
                  >
                    <td>
                      <button
                        type="button"
                        className="task-name"
                        onClick={() => onSelect(job.id)}
                      >
                        <span className={`file-status-icon ${tone}`}>
                          {job.stage === 'completed' ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <FileVideo2 aria-hidden="true" />
                          )}
                        </span>
                        <span title={job.displayName}>{job.displayName}</span>
                      </button>
                    </td>
                    <td>
                      <div className="progress-cell">
                        <span>
                          {progress === null ? '处理中' : `${Math.round(progress)}%`}
                        </span>
                        <span className="progress-track">
                          {progress === null ? (
                            <span className="progress-indeterminate" />
                          ) : (
                            <span
                              className={`progress-value ${tone}`}
                              style={{ width: `${progress}%` }}
                            />
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`job-status ${tone}`}
                        title={job.error || job.message}
                      >
                        <StatusIcon stage={job.stage} />
                        {stageLabels[job.stage]}
                      </span>
                    </td>
                    <td>
                      <StageRail job={job} />
                    </td>
                    <td>
                      {active || job.stage === 'queued' ? (
                        <button
                          type="button"
                          className="secondary-button compact-button danger-hover"
                          disabled={cancellingJobId === job.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            onCancel(job.id)
                          }}
                        >
                          {cancellingJobId === job.id ? (
                            <LoaderCircle className="spin" aria-hidden="true" />
                          ) : (
                            <X aria-hidden="true" />
                          )}
                          取消
                        </button>
                      ) : (
                        <span className="terminal-action">
                          {job.stage === 'completed' ? '已完成' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="created-at">{formatCreatedAt(job.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

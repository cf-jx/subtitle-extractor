export type SourceKind = 'local' | 'url'

export type JobStage =
  | 'queued'
  | 'resolving_url'
  | 'downloading'
  | 'probing_media'
  | 'extracting_audio'
  | 'loading_model'
  | 'transcribing'
  | 'exporting'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SubtitleSegment {
  index: number
  startMs: number
  endMs: number
  text: string
}

export interface JobOutputs {
  txt: string
  srt: string
  vtt: string
}

export interface JobSnapshot {
  id: string
  sourceKind: SourceKind
  source: string
  displayName: string
  outputDir: string
  stage: JobStage
  stageProgress: number | null
  overallProgress: number | null
  message: string
  createdAt: string
  segments: SubtitleSegment[]
  outputs: JobOutputs | null
  error: string | null
}

export interface AppInfo {
  platform: string
  modelName: string
  modelReady: boolean
}

export interface StartJobRequest {
  sourceKind: SourceKind
  source: string
  outputDir: string
}

export interface ExportTranscriptRequest {
  jobId: string
  segments: SubtitleSegment[]
}

export interface BackendAvailability {
  available: boolean
  reason: string | null
}

export type Unlisten = () => void

export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave'
  paths: string[]
}

export interface DesktopBackend {
  availability: BackendAvailability
  getAppInfo(): Promise<AppInfo>
  listJobs(): Promise<JobSnapshot[]>
  startJob(request: StartJobRequest): Promise<void>
  cancelJob(jobId: string): Promise<void>
  exportTranscript(request: ExportTranscriptRequest): Promise<void>
  pickMedia(): Promise<string | null>
  pickOutputDirectory(): Promise<string | null>
  subscribeJobUpdates(
    listener: (snapshot: JobSnapshot) => void,
  ): Promise<Unlisten>
  subscribeFileDrops(
    listener: (event: FileDropEvent) => void,
  ): Promise<Unlisten>
}

export interface UpdateProgress {
  downloadedBytes: number
  totalBytes: number | null
}

export interface AvailableUpdate {
  currentVersion: string
  version: string
  notes: string | null
  downloadAndInstall: (
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>
}

export interface UpdateService {
  available: boolean
  check: () => Promise<AvailableUpdate | null>
  relaunch: () => Promise<void>
}

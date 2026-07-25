import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import type {
  AvailableUpdate,
  UpdateService,
} from './types'

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export const tauriUpdateService: UpdateService = {
  available: isTauriRuntime(),
  async check(): Promise<AvailableUpdate | null> {
    const update = await check({ timeout: 20_000 })
    if (!update) {
      return null
    }

    return {
      currentVersion: update.currentVersion,
      version: update.version,
      notes: update.body ?? null,
      async downloadAndInstall(onProgress) {
        let downloadedBytes = 0
        let totalBytes: number | null = null

        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            totalBytes = event.data.contentLength ?? null
            onProgress({ downloadedBytes, totalBytes })
            return
          }

          if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength
            onProgress({ downloadedBytes, totalBytes })
          }
        })
      },
    }
  },
  relaunch,
}

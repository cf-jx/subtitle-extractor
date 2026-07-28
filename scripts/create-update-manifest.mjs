import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

const [
  outputPath,
  version,
  repository,
  tag,
  macAsset,
  macSignaturePath,
  windowsAsset,
  windowsSignaturePath,
  notesPath,
] = process.argv.slice(2)

if (
  !outputPath ||
  !version ||
  !repository ||
  !tag ||
  !macAsset ||
  !macSignaturePath ||
  !windowsAsset ||
  !windowsSignaturePath ||
  !notesPath
) {
  throw new Error(
    'Usage: node scripts/create-update-manifest.mjs <output> <version> <repository> <tag> <mac-asset> <mac-signature> <windows-asset> <windows-signature> <notes>',
  )
}

const [macSignature, windowsSignature, notes] = await Promise.all([
  readFile(macSignaturePath, 'utf8'),
  readFile(windowsSignaturePath, 'utf8'),
  readFile(notesPath, 'utf8'),
])
const releaseBaseUrl = `https://github.com/${repository}/releases/download/${tag}`

const manifest = {
  version,
  notes: notes.trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: macSignature.trim(),
      url: `${releaseBaseUrl}/${encodeURIComponent(macAsset)}`,
    },
    'windows-x86_64': {
      signature: windowsSignature.trim(),
      url: `${releaseBaseUrl}/${encodeURIComponent(windowsAsset)}`,
    },
  },
}

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

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
] = process.argv.slice(2)

if (
  !outputPath ||
  !version ||
  !repository ||
  !tag ||
  !macAsset ||
  !macSignaturePath ||
  !windowsAsset ||
  !windowsSignaturePath
) {
  throw new Error(
    'Usage: node scripts/create-update-manifest.mjs <output> <version> <repository> <tag> <mac-asset> <mac-signature> <windows-asset> <windows-signature>',
  )
}

const [macSignature, windowsSignature] = await Promise.all([
  readFile(macSignaturePath, 'utf8'),
  readFile(windowsSignaturePath, 'utf8'),
])
const releaseBaseUrl = `https://github.com/${repository}/releases/download/${tag}`

const manifest = {
  version,
  notes: `文案提取 ${tag} 已发布，包含功能改进和问题修复。`,
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

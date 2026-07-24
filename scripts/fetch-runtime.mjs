import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { basename, join, resolve } from 'node:path'

const MODEL = {
  name: 'ggml-small-q5_1.bin',
  revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  bytes: 190_085_487,
}

const YT_DLP_VERSION = '2026.07.04'
const YT_DLP = {
  macos: {
    asset: 'yt-dlp_macos',
    sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
  },
  windows: {
    asset: 'yt-dlp.exe',
    sha256: '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8',
  },
}

const projectRoot = resolve(import.meta.dirname, '..')
const modelDirectory = join(projectRoot, 'src-tauri', 'resources', 'models')
const binaryDirectory = join(projectRoot, 'src-tauri', 'binaries')

function readTarget() {
  const targetFlag = process.argv.indexOf('--target')
  const target = targetFlag >= 0 ? process.argv[targetFlag + 1] : undefined
  if (!target) {
    throw new Error('Missing --target <target-triple>')
  }
  if (
    ![
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
    ].includes(target)
  ) {
    throw new Error(`Unsupported target: ${target}`)
  }
  return target
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function isCurrent(path, expectedHash, expectedBytes) {
  try {
    const file = await stat(path)
    if (expectedBytes !== undefined && file.size !== expectedBytes) {
      return false
    }
    return (await sha256(path)) === expectedHash
  } catch {
    return false
  }
}

async function download(url, destination, expectedHash, expectedBytes) {
  if (await isCurrent(destination, expectedHash, expectedBytes)) {
    console.log(`Verified ${basename(destination)}`)
    return
  }

  const temporary = `${destination}.part`
  await rm(temporary, { force: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`)
  }
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(temporary)))

  if (!(await isCurrent(temporary, expectedHash, expectedBytes))) {
    await rm(temporary, { force: true })
    throw new Error(`Checksum or size mismatch: ${basename(destination)}`)
  }
  await rename(temporary, destination)
  console.log(`Downloaded and verified ${basename(destination)}`)
}

async function main() {
  const target = readTarget()
  await Promise.all([
    mkdir(modelDirectory, { recursive: true }),
    mkdir(binaryDirectory, { recursive: true }),
  ])

  await download(
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL.revision}/${MODEL.name}`,
    join(modelDirectory, MODEL.name),
    MODEL.sha256,
    MODEL.bytes,
  )

  const windows = target === 'x86_64-pc-windows-msvc'
  const metadata = windows ? YT_DLP.windows : YT_DLP.macos
  const executableName = windows ? `yt-dlp-${target}.exe` : `yt-dlp-${target}`
  const executablePath = join(binaryDirectory, executableName)
  await download(
    `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${metadata.asset}`,
    executablePath,
    metadata.sha256,
  )
  if (!windows) {
    await chmod(executablePath, 0o755)
  }
}

await main()

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const TARGET = 'x86_64-pc-windows-msvc'
const PE_SIGNATURE = 0x0000_4550
const AMD64_MACHINE = 0x8664
const MODEL_BYTES = 190_085_487
const MODEL_SHA256 =
  'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
const YT_DLP_SHA256 =
  '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'

const projectRoot = resolve(import.meta.dirname, '..')
const binaryDirectory = join(projectRoot, 'src-tauri', 'binaries')
const modelPath = join(
  projectRoot,
  'src-tauri',
  'resources',
  'models',
  'ggml-small-q5_1.bin',
)
const runtimePaths = [
  join(binaryDirectory, `ffmpeg-${TARGET}.exe`),
  join(binaryDirectory, `ffprobe-${TARGET}.exe`),
  join(binaryDirectory, `yt-dlp-${TARGET}.exe`),
]

async function sha256(filePath) {
  const file = await open(filePath, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await file.close()
  }
  return hash.digest('hex')
}

async function readPeMachine(filePath) {
  const file = await open(filePath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    const dosRead = await file.read(dosHeader, 0, dosHeader.length, 0)
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`${basename(filePath)} is not a DOS/PE executable`)
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(6)
    const peRead = await file.read(peHeader, 0, peHeader.length, peOffset)
    if (
      peRead.bytesRead !== peHeader.length ||
      peHeader.readUInt32LE(0) !== PE_SIGNATURE
    ) {
      throw new Error(`${basename(filePath)} has an invalid PE signature`)
    }
    return peHeader.readUInt16LE(4)
  } finally {
    await file.close()
  }
}

for (const runtimePath of runtimePaths) {
  const metadata = await stat(runtimePath)
  if (!metadata.isFile() || metadata.size < 512 * 1024) {
    throw new Error(`${basename(runtimePath)} is missing or unexpectedly small`)
  }
  const machine = await readPeMachine(runtimePath)
  if (machine !== AMD64_MACHINE) {
    throw new Error(
      `${basename(runtimePath)} is not AMD64 PE (machine=0x${machine.toString(16)})`,
    )
  }
  console.log(`Verified AMD64 PE: ${basename(runtimePath)}`)
}

const ytDlpPath = runtimePaths[2]
if ((await sha256(ytDlpPath)) !== YT_DLP_SHA256) {
  throw new Error('yt-dlp checksum mismatch')
}

const modelMetadata = await stat(modelPath)
if (modelMetadata.size !== MODEL_BYTES) {
  throw new Error(`Whisper model size mismatch: ${modelMetadata.size}`)
}
if ((await sha256(modelPath)) !== MODEL_SHA256) {
  throw new Error('Whisper model checksum mismatch')
}

console.log('Verified pinned Windows runtime and Whisper model')

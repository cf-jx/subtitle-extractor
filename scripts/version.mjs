import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function readVersions() {
  const packagePath = path.join(projectRoot, 'package.json')
  const tauriPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json')
  const cargoPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml')
  const [packageSource, tauriSource, cargoSource] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(tauriPath, 'utf8'),
    readFile(cargoPath, 'utf8'),
  ])
  const packageJson = JSON.parse(packageSource)
  const tauriJson = JSON.parse(tauriSource)
  const cargoVersion = cargoSource.match(
    /^\[package\][\s\S]*?^version = "([^"]+)"/m,
  )?.[1]

  if (!cargoVersion) {
    throw new Error('Cargo package version was not found')
  }

  return {
    paths: { packagePath, tauriPath, cargoPath },
    sources: { packageJson, tauriJson, cargoSource },
    versions: {
      package: packageJson.version,
      tauri: tauriJson.version,
      cargo: cargoVersion,
    },
  }
}

function validateVersion(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`)
  }
}

async function checkVersions(expectedVersion) {
  const { versions } = await readVersions()
  const uniqueVersions = new Set(Object.values(versions))

  if (uniqueVersions.size !== 1) {
    throw new Error(
      `Version mismatch: package=${versions.package}, tauri=${versions.tauri}, cargo=${versions.cargo}`,
    )
  }

  const currentVersion = versions.package
  if (expectedVersion && currentVersion !== expectedVersion) {
    throw new Error(
      `Release version ${expectedVersion} does not match app version ${currentVersion}`,
    )
  }

  process.stdout.write(`${currentVersion}\n`)
}

async function setVersion(version) {
  validateVersion(version)
  const { paths, sources } = await readVersions()

  sources.packageJson.version = version
  sources.tauriJson.version = version
  const cargoSource = sources.cargoSource.replace(
    /^(\[package\][\s\S]*?^version = ")[^"]+(")/m,
    `$1${version}$2`,
  )

  await Promise.all([
    writeFile(
      paths.packagePath,
      `${JSON.stringify(sources.packageJson, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      paths.tauriPath,
      `${JSON.stringify(sources.tauriJson, null, 2)}\n`,
      'utf8',
    ),
    writeFile(paths.cargoPath, cargoSource, 'utf8'),
  ])

  process.stdout.write(`Version updated to ${version}\n`)
}

const [command, value] = process.argv.slice(2)

if (command === '--check') {
  if (value) {
    validateVersion(value)
  }
  await checkVersions(value)
} else if (command) {
  await setVersion(command)
} else {
  throw new Error(
    'Usage: node scripts/version.mjs <version> | node scripts/version.mjs --check [expected-version]',
  )
}

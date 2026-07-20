import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { marketCdnPublicationDecision } from './sign-market-index.mjs'

const indexPath = resolve('index.json')
const marketDir = dirname(indexPath)
const indexBytes = readFileSync(indexPath)
const index = JSON.parse(indexBytes)
const publicKeys = JSON.parse(required('SEKAITEXT_PLUGIN_PUBLIC_KEYS'))
const accessKeyId = required('OSS_ACCESS_KEY_ID')
const accessKeySecret = required('OSS_ACCESS_KEY_SECRET')
const region = required('OSS_REGION')
const bucket = required('OSS_BUCKET')
const cdnOrigin = required('CDN_ORIGIN').replace(/\/$/, '')

delete process.env.OSS_ACCESS_KEY_ID
delete process.env.OSS_ACCESS_KEY_SECRET

const liveResponse = await fetch(`${cdnOrigin}/sekaitext-plugins/index.json?preflight=${Date.now()}`, {
  cache: 'no-store',
  signal: AbortSignal.timeout(30_000),
})
if (liveResponse.ok) {
  const live = await liveResponse.json()
  const decision = marketCdnPublicationDecision(live, index, indexPath, publicKeys)
  if (decision === 'newer-current') {
    console.log(`[sync-market-cdn] CDN sequence ${live.sequence} is newer than candidate ${index.sequence}; nothing to do.`)
    process.exit(0)
  }
  if (decision === 'already-current') {
    console.log(`[sync-market-cdn] CDN already serves sequence ${index.sequence}.`)
    process.exit(0)
  }
} else if (liveResponse.status !== 404) {
  throw new Error(`could not read current CDN index (HTTP ${liveResponse.status})`)
} else {
  marketCdnPublicationDecision(null, index, indexPath, publicKeys)
}

const ossAuth = [
  '--region', region,
  '--access-key-id', accessKeyId,
  '--access-key-secret', accessKeySecret,
]

for (const entry of index.plugins) {
  const filename = basename(new URL(entry.download).pathname)
  const localPath = join(marketDir, 'plugins', filename)
  const publicURL = `${cdnOrigin}/sekaitext-plugins/plugins/${filename}`
  const existing = await fetch(`${publicURL}?immutable-preflight=${Date.now()}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  })
  if (existing.ok) {
    const digest = createHash('sha256').update(Buffer.from(await existing.arrayBuffer())).digest('hex')
    if (digest !== entry.sha256) throw new Error(`refusing to overwrite non-matching immutable CDN object ${filename}`)
    continue
  }
  if (existing.status !== 404) throw new Error(`${publicURL} preflight returned HTTP ${existing.status}`)

  oss([
    'cp', localPath, `oss://${bucket}/sekaitext-plugins/plugins/${filename}`,
    '--force',
    '--cache-control', 'public, max-age=31536000, immutable',
  ])
  await requireCDNDigest(publicURL, entry.sha256)
}

oss([
  'cp', indexPath, `oss://${bucket}/sekaitext-plugins/index.json`,
  '--force',
  '--cache-control', 'no-cache, no-store, must-revalidate',
])

for (let attempt = 1; attempt <= 6; attempt++) {
  const response = await fetch(`${cdnOrigin}/sekaitext-plugins/index.json?publish-check=${Date.now()}-${attempt}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.ok) {
    const published = await response.json()
    if (published.snapshotSignature === index.snapshotSignature) {
      const decision = marketCdnPublicationDecision(published, index, indexPath, publicKeys)
      if (decision !== 'already-current') throw new Error('published CDN index identity is inconsistent')
      console.log(`[sync-market-cdn] published and verified market sequence ${index.sequence}`)
      process.exit(0)
    }
  }
  if (attempt < 6) await delay(attempt * 5_000)
}
throw new Error(`CDN did not serve market sequence ${index.sequence} after publication`)

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function oss(args) {
  execFileSync('ossutil', [...ossAuth, ...args], {
    env: safeEnv(),
    stdio: 'inherit',
  })
}

function safeEnv() {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'GITHUB_ACTIONS']) {
    if (process.env[name] != null) env[name] = process.env[name]
  }
  return env
}

async function requireCDNDigest(url, expected) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(`${url}?upload-check=${Date.now()}-${attempt}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) {
      const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')
      if (digest === expected) return
    }
    if (attempt < 6) await delay(attempt * 5_000)
  }
  throw new Error(`${url} did not serve the expected immutable bytes after upload`)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

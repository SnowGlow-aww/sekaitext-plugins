import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLISHER = 'sekaitext-official'
export const ALGORITHM = 'ed25519'
export const PACKAGE_HEADER = 'SekaiText-Plugin-Signature-V1\n'
export const METADATA_HEADER = 'SekaiText-Plugin-Metadata-Signature-V2\n'
export const SNAPSHOT_HEADER = 'SekaiText-Plugin-Market-Snapshot-V1\n'

const INDEX_KEYS = new Set([
  'version', 'plugins', 'publisher', 'keyId', 'signatureAlgorithm', 'sequence',
  'expiresAt', 'snapshotSignature',
])
const ENTRY_KEYS = new Set([
  'id', 'name', 'version', 'description', 'author', 'icon', 'minHostVersion',
  'download', 'sha256', 'homepage', 'publisher', 'keyId',
  'signatureAlgorithm', 'packageSignature', 'sequence', 'expiresAt',
  'metadataSignature',
])
const MANIFEST_KEYS = new Set([
  'id', 'name', 'version', 'description', 'author', 'entry', 'minHostVersion', 'icon',
])
const LEGACY_ENTRY_KEYS = new Set([
  'id', 'name', 'version', 'description', 'author', 'icon', 'minHostVersion',
  'download', 'sha256', 'homepage',
])
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, allowed, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  for (const key of Object.keys(value)) invariant(allowed.has(key), `${label} has unknown property ${key}`)
}

function canonicalBase64(value, label, expectedBytes) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is missing`)
  const decoded = Buffer.from(value, 'base64')
  invariant(decoded.toString('base64') === value, `${label} must use standard padded Base64`)
  if (expectedBytes != null) invariant(decoded.length === expectedBytes, `${label} must decode to ${expectedBytes} bytes`)
  return decoded
}

function boundedString(value, maxBytes, label, { optional = false, nonBlank = false } = {}) {
  if (optional && value === undefined) return
  invariant(
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && (!nonBlank || value.trim()),
    `${label} is invalid`,
  )
}

function field(name, value) {
  invariant(typeof value === 'string', `entry ${name} must be a string`)
  return `${name}:${Buffer.byteLength(value, 'utf8')}:${value}\n`
}

export function canonicalPackagePayload(entry) {
  return Buffer.from(
    PACKAGE_HEADER +
      field('publisher', entry.publisher) +
      field('keyId', entry.keyId) +
      field('algorithm', entry.signatureAlgorithm) +
      field('id', entry.id) +
      field('version', entry.version) +
      field('download', entry.download) +
      field('sha256', entry.sha256),
    'utf8',
  )
}

export function canonicalMetadataPayload(entry) {
  return Buffer.from(
    METADATA_HEADER +
      field('publisher', entry.publisher) +
      field('keyId', entry.keyId) +
      field('algorithm', entry.signatureAlgorithm) +
      field('id', entry.id) +
      field('name', entry.name) +
      field('version', entry.version) +
      field('description', entry.description ?? '') +
      field('author', entry.author ?? '') +
      field('icon', entry.icon ?? '') +
      field('minHostVersion', entry.minHostVersion ?? '') +
      field('download', entry.download) +
      field('sha256', entry.sha256) +
      field('homepage', entry.homepage ?? '') +
      field('sequence', String(entry.sequence)) +
      field('expiresAt', entry.expiresAt),
    'utf8',
  )
}

export function canonicalSnapshotPayload(index) {
  let payload = SNAPSHOT_HEADER +
    field('publisher', index.publisher) +
    field('keyId', index.keyId) +
    field('algorithm', index.signatureAlgorithm) +
    field('version', String(index.version)) +
    field('sequence', String(index.sequence)) +
    field('expiresAt', index.expiresAt) +
    field('pluginCount', String(index.plugins.length))
  for (const entry of index.plugins) {
    payload += field('pluginId', entry.id) + field('metadataSignature', entry.metadataSignature)
  }
  return Buffer.from(payload, 'utf8')
}

export function marketExpiry(now = Date.now()) {
  const expiry = new Date(now + 180 * 24 * 60 * 60 * 1000)
  expiry.setUTCMilliseconds(0)
  return expiry.toISOString().replace('.000Z', 'Z')
}

function validateHTTPS(value, label) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`${label} must be an absolute URL`) }
  invariant(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash, `${label} must use HTTPS without credentials or fragments`)
  return parsed
}

function validateManifest(manifest, label) {
  exactKeys(manifest, MANIFEST_KEYS, label)
  invariant(/^[A-Za-z0-9_-]{1,64}$/.test(manifest.id ?? ''), `${label}.id is invalid`)
  boundedString(manifest.name, 200, `${label}.name`, { nonBlank: true })
  invariant(STABLE_SEMVER.test(manifest.version ?? ''), `${label}.version must be stable strict semver`)
  invariant(manifest.entry === 'entry.js', `${label}.entry must be entry.js`)
  if (manifest.minHostVersion != null && manifest.minHostVersion !== '') {
    invariant(STABLE_SEMVER.test(manifest.minHostVersion), `${label}.minHostVersion must be stable strict semver`)
  }
  boundedString(manifest.description, 4000, `${label}.description`, { optional: true })
  boundedString(manifest.author, 200, `${label}.author`, { optional: true })
  boundedString(manifest.icon, 100, `${label}.icon`, { optional: true })
}

function commandEnv() {
  const env = { ...process.env }
  delete env.PLUGIN_SIGNING_PRIVATE_KEY
  return env
}

function readArchiveManifest(packagePath, entry) {
  const listing = execFileSync('unzip', ['-Z1', packagePath], { encoding: 'utf8', env: commandEnv() })
    .split(/\r?\n/)
    .filter(Boolean)
  invariant(listing.filter((name) => name === 'manifest.json').length === 1, `${entry.id}: archive must contain exactly one root manifest.json`)
  invariant(listing.includes('entry.js'), `${entry.id}: archive is missing root entry.js`)
  let manifest
  try {
    manifest = JSON.parse(execFileSync('unzip', ['-p', packagePath, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: commandEnv(),
    }))
  } catch {
    throw new Error(`${entry.id}: archive manifest.json is invalid`)
  }
  validateManifest(manifest, `${entry.id} archive manifest`)
  invariant(manifest.id === entry.id, `${entry.id}: archive manifest id mismatch`)
  invariant(manifest.version === entry.version, `${entry.id}: archive manifest version mismatch`)
  for (const key of ['name', 'description', 'author', 'icon', 'minHostVersion']) {
    invariant((manifest[key] ?? '') === (entry[key] ?? ''), `${entry.id}: archive manifest ${key} differs from market metadata`)
  }
}

export function validateIndex(index, indexPath, publicKeys = null, { allowExpired = false } = {}) {
  exactKeys(index, INDEX_KEYS, 'index')
  invariant(index.version === 2 || index.version === 3, 'index.version must be 2 or 3')
  invariant(Array.isArray(index.plugins) && index.plugins.length > 0 && index.plugins.length <= 1000, 'index.plugins must be a non-empty bounded array')
  if (index.version === 2) {
    for (const key of ['publisher', 'keyId', 'signatureAlgorithm', 'sequence', 'expiresAt', 'snapshotSignature']) {
      invariant(index[key] == null, `index.${key} is forbidden in index v2`)
    }
  } else {
    invariant(index.publisher === PUBLISHER, 'index.publisher is invalid')
    invariant(/^[A-Za-z0-9._-]{1,64}$/.test(index.keyId ?? ''), 'index.keyId is invalid')
    invariant(index.signatureAlgorithm === ALGORITHM, 'index.signatureAlgorithm is invalid')
    invariant(Number.isSafeInteger(index.sequence) && index.sequence > 0, 'index.sequence must be a positive safe integer')
    const expires = new Date(index.expiresAt)
    invariant(!Number.isNaN(expires.valueOf()) && expires.toISOString().replace('.000Z', 'Z') === index.expiresAt, 'index.expiresAt must be canonical RFC3339 UTC')
    if (!allowExpired) invariant(expires > new Date(), 'index.expiresAt must be in the future')
    canonicalBase64(index.snapshotSignature, 'index.snapshotSignature', 64)
  }
  const seen = new Set()
  for (const entry of index.plugins) {
    exactKeys(entry, ENTRY_KEYS, `entry ${entry?.id ?? '(unknown)'}`)
    invariant(/^[A-Za-z0-9_-]{1,64}$/.test(entry.id ?? ''), 'entry id is invalid')
    invariant(!seen.has(entry.id), `duplicate plugin id: ${entry.id}`)
    seen.add(entry.id)
    boundedString(entry.name, 200, `${entry.id}: name`, { nonBlank: true })
    invariant(STABLE_SEMVER.test(entry.version ?? ''), `${entry.id}: version must be stable strict semver`)
    if (entry.minHostVersion != null && entry.minHostVersion !== '') {
      invariant(STABLE_SEMVER.test(entry.minHostVersion), `${entry.id}: minHostVersion must be stable strict semver`)
    }
    boundedString(entry.description, 4000, `${entry.id}: description`, { optional: true })
    boundedString(entry.author, 200, `${entry.id}: author`, { optional: true })
    boundedString(entry.icon, 100, `${entry.id}: icon`, { optional: true })
    const packageURL = validateHTTPS(entry.download, `${entry.id}: download`)
    if (entry.homepage != null && entry.homepage !== '') validateHTTPS(entry.homepage, `${entry.id}: homepage`)
    invariant(/^[0-9a-f]{64}$/.test(entry.sha256 ?? ''), `${entry.id}: sha256 must be 64 lowercase hex characters`)
    invariant(entry.publisher === PUBLISHER, `${entry.id}: publisher is invalid`)
    invariant(/^[A-Za-z0-9._-]{1,64}$/.test(entry.keyId ?? ''), `${entry.id}: keyId is invalid`)
    invariant(entry.signatureAlgorithm === ALGORITHM, `${entry.id}: signatureAlgorithm is invalid`)
    canonicalBase64(entry.packageSignature, `${entry.id}: packageSignature`, 64)

    const packageName = basename(packageURL.pathname)
    invariant(packageName === `${entry.id}-${entry.version}.sekplugin`, `${entry.id}: archive filename must exactly match id and version`)
    const packagePath = join(dirname(indexPath), 'plugins', packageName)
    invariant(existsSync(packagePath), `${entry.id}: package is missing: plugins/${packageName}`)
    const actualDigest = createHash('sha256').update(readFileSync(packagePath)).digest('hex')
    invariant(actualDigest === entry.sha256, `${entry.id}: sha256 does not match plugins/${packageName}`)
    readArchiveManifest(packagePath, entry)

    if (index.version === 2) {
      invariant(entry.sequence == null && entry.expiresAt == null && entry.metadataSignature == null, `${entry.id}: v3 fields are forbidden in index v2`)
    } else {
      invariant(Number.isSafeInteger(entry.sequence) && entry.sequence > 0, `${entry.id}: sequence must be a positive safe integer`)
      const expires = new Date(entry.expiresAt)
      invariant(!Number.isNaN(expires.valueOf()) && expires.toISOString().replace('.000Z', 'Z') === entry.expiresAt, `${entry.id}: expiresAt must be canonical RFC3339 UTC`)
      if (!allowExpired) invariant(expires > new Date(), `${entry.id}: expiresAt must be in the future`)
      canonicalBase64(entry.metadataSignature, `${entry.id}: metadataSignature`, 64)
      invariant(
        entry.publisher === index.publisher && entry.keyId === index.keyId &&
          entry.signatureAlgorithm === index.signatureAlgorithm &&
          entry.sequence === index.sequence && entry.expiresAt === index.expiresAt,
        `${entry.id}: v3 signing metadata must match the snapshot`,
      )
    }

    if (publicKeys) {
      const encoded = publicKeys[entry.keyId]
      const raw = canonicalBase64(encoded, `trusted public key ${entry.keyId}`, 32)
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
      const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' })
      invariant(verify(null, canonicalPackagePayload(entry), publicKey, Buffer.from(entry.packageSignature, 'base64')), `${entry.id}: packageSignature verification failed`)
      if (index.version === 3) {
        invariant(verify(null, canonicalMetadataPayload(entry), publicKey, Buffer.from(entry.metadataSignature, 'base64')), `${entry.id}: metadataSignature verification failed`)
      }
    }
  }
  if (publicKeys && index.version === 3) {
    const raw = canonicalBase64(publicKeys[index.keyId], `trusted public key ${index.keyId}`, 32)
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' })
    invariant(
      verify(null, canonicalSnapshotPayload(index), publicKey, Buffer.from(index.snapshotSignature, 'base64')),
      'index.snapshotSignature verification failed',
    )
  }
}

export function marketCdnPublicationDecision(live, candidate, indexPath, publicKeys) {
  validateIndex(candidate, indexPath, publicKeys)
  invariant(candidate.version === 3, 'only a complete signed v3 snapshot may be published to the CDN')
  if (live == null) return 'publish'

  if (live?.version === 1) {
    validateLegacyIndex(live)
    return 'publish'
  }

  validateIndex(live, indexPath, publicKeys, { allowExpired: true })
  if (live.version !== 3) return 'publish'
  if (live.sequence > candidate.sequence) return 'newer-current'
  if (live.sequence < candidate.sequence) return 'publish'
  invariant(
    live.keyId === candidate.keyId && live.snapshotSignature === candidate.snapshotSignature,
    `CDN has a different signed snapshot at sequence ${candidate.sequence}`,
  )
  return 'already-current'
}

function validateLegacyIndex(index) {
  exactKeys(index, new Set(['version', 'plugins']), 'legacy CDN index')
  invariant(index.version === 1, 'legacy CDN index version is invalid')
  invariant(Array.isArray(index.plugins) && index.plugins.length > 0 && index.plugins.length <= 1000, 'legacy CDN index plugins must be a non-empty bounded array')
  const seen = new Set()
  for (const entry of index.plugins) {
    exactKeys(entry, LEGACY_ENTRY_KEYS, `legacy CDN entry ${entry?.id ?? '(unknown)'}`)
    invariant(/^[A-Za-z0-9_-]{1,64}$/.test(entry.id ?? '') && !seen.has(entry.id), 'legacy CDN index contains an invalid or duplicate plugin id')
    seen.add(entry.id)
    boundedString(entry.name, 200, `${entry.id}: legacy name`, { nonBlank: true })
    boundedString(entry.description, 4000, `${entry.id}: legacy description`, { optional: true })
    boundedString(entry.author, 200, `${entry.id}: legacy author`, { optional: true })
    boundedString(entry.icon, 100, `${entry.id}: legacy icon`, { optional: true })
    invariant(STABLE_SEMVER.test(entry.version ?? ''), `${entry.id}: legacy version must be stable strict semver`)
    if (entry.minHostVersion != null && entry.minHostVersion !== '') {
      invariant(STABLE_SEMVER.test(entry.minHostVersion), `${entry.id}: legacy minHostVersion must be stable strict semver`)
    }
    const packageURL = validateHTTPS(entry.download, `${entry.id}: legacy download`)
    invariant(basename(packageURL.pathname) === `${entry.id}-${entry.version}.sekplugin`, `${entry.id}: legacy archive filename must exactly match id and version`)
    if (entry.homepage != null && entry.homepage !== '') validateHTTPS(entry.homepage, `${entry.id}: legacy homepage`)
    invariant(/^[0-9a-f]{64}$/.test(entry.sha256 ?? ''), `${entry.id}: legacy sha256 must be 64 lowercase hex characters`)
  }
}

function parseTrustedKeys(raw) {
  let keys
  try { keys = JSON.parse(raw) } catch { throw new Error('SEKAITEXT_PLUGIN_PUBLIC_KEYS must be a JSON object') }
  invariant(keys && typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length > 0, 'SEKAITEXT_PLUGIN_PUBLIC_KEYS must be a non-empty JSON object')
  for (const [keyId, value] of Object.entries(keys)) {
    invariant(/^[A-Za-z0-9._-]{1,64}$/.test(keyId), `trusted keyId is invalid: ${keyId}`)
    canonicalBase64(value, `trusted public key ${keyId}`, 32)
  }
  return keys
}

export function signIndex(index, indexPath, env = process.env) {
  const keyId = env.PLUGIN_SIGNING_KEY_ID ?? ''
  invariant(/^[A-Za-z0-9._-]{1,64}$/.test(keyId), 'PLUGIN_SIGNING_KEY_ID is missing or invalid')
  const privateKey = createPrivateKey({
    key: canonicalBase64(env.PLUGIN_SIGNING_PRIVATE_KEY ?? '', 'PLUGIN_SIGNING_PRIVATE_KEY'),
    format: 'der',
    type: 'pkcs8',
  })
  invariant(privateKey.asymmetricKeyType === 'ed25519', 'PLUGIN_SIGNING_PRIVATE_KEY is not an Ed25519 key')
  const trustedKeys = parseTrustedKeys(env.SEKAITEXT_PLUGIN_PUBLIC_KEYS ?? '')
  const rawPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  invariant(trustedKeys[keyId] === rawPublicKey, `signing key ${keyId} does not match the official app trust map`)

  // Authenticate the complete prior snapshot before changing any signing
  // metadata. Otherwise a write compromise of the market repository could
  // replace another package/digest and have this trusted signer bless it.
  // Expiry is intentionally ignored only for this renewal check: an expired
  // signature is still cryptographic provenance, while output is required to
  // receive a fresh future expiry below.
  validateIndex(index, indexPath, trustedKeys, { allowExpired: true })

  const requestedSequence = Number(env.MARKET_SEQUENCE ?? Date.now())
  invariant(Number.isSafeInteger(requestedSequence) && requestedSequence > 0, 'MARKET_SEQUENCE must be a positive safe integer')
  const priorMaximum = Math.max(0, ...index.plugins.map((entry) => Number.isSafeInteger(entry.sequence) ? entry.sequence : 0))
  const sequence = Math.max(requestedSequence, priorMaximum + 1)
  const expiresAt = env.MARKET_EXPIRES_AT || marketExpiry()

  index.version = 3
  index.publisher = PUBLISHER
  index.keyId = keyId
  index.signatureAlgorithm = ALGORITHM
  index.sequence = sequence
  index.expiresAt = expiresAt
  for (const entry of index.plugins) {
    entry.publisher = PUBLISHER
    entry.keyId = keyId
    entry.signatureAlgorithm = ALGORITHM
    entry.sequence = sequence
    entry.expiresAt = expiresAt
    entry.packageSignature = sign(null, canonicalPackagePayload(entry), privateKey).toString('base64')
    entry.metadataSignature = sign(null, canonicalMetadataPayload(entry), privateKey).toString('base64')
  }
  index.snapshotSignature = sign(null, canonicalSnapshotPayload(index), privateKey).toString('base64')
  validateIndex(index, indexPath, trustedKeys)
  return { keyId, sequence }
}

function readIndex(indexPath) {
  let index
  try { index = JSON.parse(readFileSync(indexPath, 'utf8')) } catch { throw new Error('index is not valid JSON') }
  return index
}

function main() {
  const validateOnly = process.argv.includes('--validate')
  const pathArg = process.argv.find((arg, index) => index > 1 && arg !== '--validate')
  const indexPath = resolve(pathArg || 'index.json')
  invariant(existsSync(indexPath), `index not found: ${indexPath}`)
  const index = readIndex(indexPath)
  if (validateOnly) {
    const keys = process.env.SEKAITEXT_PLUGIN_PUBLIC_KEYS ? parseTrustedKeys(process.env.SEKAITEXT_PLUGIN_PUBLIC_KEYS) : null
    validateIndex(index, indexPath, keys)
    console.log(`[sign-market-index] validated ${index.plugins.length} entries`)
    return
  }
  const result = signIndex(index, indexPath)
  const tempPath = `${indexPath}.${process.pid}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    renameSync(tempPath, indexPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
  console.log(`[sign-market-index] signed ${index.plugins.length} entries with keyId ${result.keyId}, sequence ${result.sequence}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main() } catch (error) {
    console.error(`[sign-market-index] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

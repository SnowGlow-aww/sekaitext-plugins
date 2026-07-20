import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  canonicalMetadataPayload,
  canonicalPackagePayload,
  canonicalSnapshotPayload,
  marketExpiry,
  marketCdnPublicationDecision,
  signIndex,
  validateIndex,
} from './sign-market-index.mjs'

const cdnPublisherSource = readFileSync(new URL('./sync-market-cdn.mjs', import.meta.url), 'utf8')

function fixtureEntry(root, overrides = {}) {
  const manifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.2.3',
    description: 'Description',
    author: 'Author',
    entry: 'entry.js',
    minHostVersion: '5.0.0',
    icon: 'Puzzle',
    ...overrides,
  }
  const stage = join(root, `stage-${manifest.id}`)
  const plugins = join(root, 'plugins')
  mkdirSync(stage)
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(stage, 'entry.js'), 'export function setup() {}\n')
  const archive = join(plugins, `${manifest.id}-${manifest.version}.sekplugin`)
  execFileSync('zip', ['-X', '-q', archive, 'manifest.json', 'entry.js'], { cwd: stage })
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const entry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    icon: manifest.icon,
    minHostVersion: manifest.minHostVersion,
    download: `https://example.test/plugins/${manifest.id}-${manifest.version}.sekplugin`,
    sha256,
    homepage: `https://example.test/${manifest.id}`,
    publisher: 'sekaitext-official',
    keyId: 'test-key',
    signatureAlgorithm: 'ed25519',
    packageSignature: Buffer.alloc(64).toString('base64'),
  }
  return entry
}

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'market-signer-test-'))
  return { root, indexPath: join(root, 'index.json'), entry: fixtureEntry(root, overrides) }
}

function signer(entry) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'test-key'
  entry.packageSignature = sign(null, canonicalPackagePayload(entry), privateKey).toString('base64')
  return {
    privateKey,
    env: {
      PLUGIN_SIGNING_KEY_ID: keyId,
      PLUGIN_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      SEKAITEXT_PLUGIN_PUBLIC_KEYS: JSON.stringify({
        [keyId]: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
      }),
      MARKET_SEQUENCE: '100',
      MARKET_EXPIRES_AT: '2030-01-01T00:00:00Z',
    },
  }
}

test('v2 schema and archive manifest validation accepts a matching package', () => {
  const { indexPath, entry } = fixture()
  assert.doesNotThrow(() => validateIndex({ version: 2, plugins: [entry] }, indexPath))
})

test('homepage must use HTTPS', () => {
  const { indexPath, entry } = fixture()
  entry.homepage = 'http://example.test/demo'
  assert.throws(() => validateIndex({ version: 2, plugins: [entry] }, indexPath), /homepage must use HTTPS/)
})

test('generated market expiry uses canonical UTC seconds', () => {
  assert.equal(marketExpiry(Date.parse('2026-07-20T14:08:57.364Z')), '2027-01-16T14:08:57Z')
})

test('signer enforces display limits in UTF-8 bytes', () => {
  const valid = fixture({ name: `${'界'.repeat(66)}aa` })
  assert.doesNotThrow(() => validateIndex({ version: 2, plugins: [valid.entry] }, valid.indexPath))

  const invalid = fixture({ name: '界'.repeat(67) })
  assert.throws(() => validateIndex({ version: 2, plugins: [invalid.entry] }, invalid.indexPath), /name is invalid/)
})

test('metadata canonical payload changes for every displayed field', () => {
  const { entry } = fixture()
  entry.sequence = 7
  entry.expiresAt = '2030-01-01T00:00:00Z'
  const original = canonicalMetadataPayload(entry)
  for (const field of ['name', 'description', 'author', 'icon', 'minHostVersion', 'homepage']) {
    const changed = { ...entry, [field]: `${entry[field]} changed` }
    assert.notDeepEqual(canonicalMetadataPayload(changed), original, field)
  }
})

test('signer verifies every existing package signature before re-signing', () => {
  const { indexPath, entry } = fixture()
  const { env } = signer(entry)
  const index = { version: 2, plugins: [entry] }
  assert.doesNotThrow(() => signIndex(index, indexPath, env))
  assert.equal(index.version, 3)

  const compromised = fixture()
  const compromisedSigner = signer(compromised.entry)
  compromised.entry.packageSignature = Buffer.alloc(64).toString('base64')
  assert.throws(
    () => signIndex({ version: 2, plugins: [compromised.entry] }, compromised.indexPath, compromisedSigner.env),
    /packageSignature verification failed/,
  )
})

test('v3 snapshot signature authenticates complete equal-sequence membership', () => {
  const { root, indexPath, entry } = fixture()
  const { privateKey, env } = signer(entry)
  const second = fixtureEntry(root, { id: 'second', name: 'Second', version: '2.0.0' })
  second.packageSignature = sign(null, canonicalPackagePayload(second), privateKey).toString('base64')
  const index = { version: 2, plugins: [entry, second] }

  signIndex(index, indexPath, env)
  const trustMap = JSON.parse(env.SEKAITEXT_PLUGIN_PUBLIC_KEYS)
  assert.doesNotThrow(() => validateIndex(index, indexPath, trustMap))

  const removedEntry = structuredClone(index)
  removedEntry.plugins.pop()
  assert.throws(
    () => validateIndex(removedEntry, indexPath, trustMap),
    /snapshotSignature verification failed/,
  )
})

test('renewal accepts authentic expired v3 input but emits a fresh expiry', () => {
  const { indexPath, entry } = fixture()
  const { privateKey, env } = signer(entry)
  const index = { version: 2, plugins: [entry] }
  signIndex(index, indexPath, env)
  index.expiresAt = '2020-01-01T00:00:00Z'
  entry.sequence = 99
  entry.expiresAt = '2020-01-01T00:00:00Z'
  entry.metadataSignature = sign(null, canonicalMetadataPayload(entry), privateKey).toString('base64')
  index.sequence = 99
  index.snapshotSignature = sign(null, canonicalSnapshotPayload(index), privateKey).toString('base64')

  assert.doesNotThrow(() => signIndex(index, indexPath, env))
  assert.equal(entry.expiresAt, env.MARKET_EXPIRES_AT)
  assert.equal(entry.sequence, 100)
})

test('CDN publication permits a validated v1 migration and preserves v3 rollback state', () => {
  const { indexPath, entry } = fixture()
  const { env } = signer(entry)
  const legacy = { version: 1, plugins: [structuredClone(entry)] }
  for (const item of legacy.plugins) {
    delete item.publisher
    delete item.keyId
    delete item.signatureAlgorithm
    delete item.packageSignature
  }
  const candidate = { version: 2, plugins: [entry] }
  signIndex(candidate, indexPath, env)
  const trustMap = JSON.parse(env.SEKAITEXT_PLUGIN_PUBLIC_KEYS)

  assert.equal(marketCdnPublicationDecision(legacy, candidate, indexPath, trustMap), 'publish')
  const olderLegacy = structuredClone(legacy)
  olderLegacy.plugins[0].version = '1.2.2'
  olderLegacy.plugins[0].download = 'https://example.test/plugins/demo-1.2.2.sekplugin'
  assert.equal(marketCdnPublicationDecision(olderLegacy, candidate, indexPath, trustMap), 'publish')

  const malformedLegacy = structuredClone(legacy)
  malformedLegacy.plugins[0].download = 'https://evil.test/arbitrary.sekplugin'
  assert.throws(
    () => marketCdnPublicationDecision(malformedLegacy, candidate, indexPath, trustMap),
    /filename must exactly match/,
  )
  assert.equal(marketCdnPublicationDecision(structuredClone(candidate), candidate, indexPath, trustMap), 'already-current')

  const newer = structuredClone(candidate)
  signIndex(newer, indexPath, { ...env, MARKET_SEQUENCE: '101' })
  assert.equal(marketCdnPublicationDecision(newer, candidate, indexPath, trustMap), 'newer-current')
  assert.equal(marketCdnPublicationDecision(candidate, newer, indexPath, trustMap), 'publish')
})

test('CDN publisher uploads and verifies immutable packages before the signed index', () => {
  const packageLoop = cdnPublisherSource.indexOf('for (const entry of index.plugins)')
  const indexUpload = cdnPublisherSource.indexOf("'cp', indexPath")
  assert.ok(packageLoop >= 0 && indexUpload > packageLoop)
  assert.ok(cdnPublisherSource.indexOf('await requireCDNDigest', packageLoop) < indexUpload)
})

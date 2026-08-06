// Fails the build if the bundle can reach anything except the user's wallet.
//
// This is the machine-checkable form of the project's core promise. It is easy
// to reintroduce a third-party dependency by accident -- one transitive import
// that pings an RPC, one remote font, one analytics snippet -- and a promise
// nobody verifies is not a promise.
//
//   node scripts/check-no-network.ts

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CHAINS } from '../src/chains/config.ts'

// Explorer links are user-initiated navigation (<a href>), not page loads. They
// are the only outside hosts allowed to appear, and only these exact ones.
const ALLOWED_HOSTS = new Set(
	Object.values(CHAINS).map(c => new URL(c.explorer).host),
)

// Hosts that appear inside harmless XML namespaces and similar boilerplate.
const IGNORED_HOSTS = new Set(['www.w3.org'])

/**
 * Hosts that viem bakes into its bundle, each reviewed and accepted. They are
 * reported as notes so they stay visible, but do not fail the build.
 *
 * Anything NOT listed here fails, so a newly introduced endpoint cannot slip in
 * quietly on a dependency bump -- the point is that adding a host requires a
 * human to write down why it is safe.
 */
const ACKNOWLEDGED_HOSTS: Readonly<Record<string, string>> = {
	'viem.sh': 'docs URL inside error message strings; never fetched',
	'abitype.dev': 'docs URL inside error message strings; never fetched',
	'oxlib.sh': 'docs URL inside error message strings; never fetched',
	'docs.soliditylang.org': 'docs URL inside error message strings; never fetched',
	'4byte.sourcify.dev': 'selector-lookup hint printed in an ABI error message; never fetched',
	'ipfs.io': 'default gateway in viem ENS avatar resolution; we never call avatar helpers',
	'arweave.net': 'default gateway in viem ENS avatar resolution; we never call avatar helpers',
}

/** Network-capable APIs that must not appear in shipped code. */
const FORBIDDEN_APIS: readonly (readonly [RegExp, string])[] = [
	[/\bnew\s+WebSocket\b/, 'WebSocket'],
	[/\bnew\s+EventSource\b/, 'EventSource'],
	[/\bimportScripts\s*\(/, 'importScripts'],
	[/\bnavigator\s*\.\s*sendBeacon\b/, 'sendBeacon'],
]

let failures = 0
const noted = new Set<string>()
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const pass = (msg: string) => console.log(`  ok    ${msg}`)

function filesIn(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
		const path = join(dir, entry.name)
		return entry.isDirectory() ? filesIn(path) : [path]
	})
}

function loadBundleFiles(): string[] {
	try {
		return filesIn('dist')
	} catch {
		console.log('  FAIL  dist/ not found. Run `npm run build` first.')
		process.exit(1)
	}
}

const bundleFiles = loadBundleFiles()

console.log('Auditing bundle for outside network access\n')

for (const file of bundleFiles) {
	if (!/\.(js|css|html|map)$/.test(file)) continue
	const source = readFileSync(file, 'utf8')

	for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
		const host = match[1]
		if (host === undefined) continue
		if (IGNORED_HOSTS.has(host)) continue
		if (ALLOWED_HOSTS.has(host)) continue
		const reason = ACKNOWLEDGED_HOSTS[host]
		if (reason !== undefined) { noted.add(`${host} — ${reason}`); continue }
		fail(`${file}: references host ${host}`)
	}

	for (const [pattern, name] of FORBIDDEN_APIS) {
		if (pattern.test(source)) fail(`${file}: uses ${name}`)
	}

	// fetch() is allowed in principle -- viem's http transport is tree-shaken out,
	// but a stray fetch to a literal URL would already have tripped the host check
	// above. Flag any fetch call anyway so it gets a human look.
	const fetchCount = [...source.matchAll(/\bfetch\s*\(/g)].length
	if (fetchCount > 0) {
		console.log(`  note  ${file}: contains ${fetchCount} fetch() call(s) — confirm none target a fixed URL`)
	}
}

// CCIP-read must stay disabled. viem enables it by default, and it fetches a URL
// supplied by a contract's OffchainLookup revert -- an outbound request triggered
// by chain data rather than by our code. Assert at source level, because the
// minified bundle renders the flag unrecognisably.
const providerSource = readFileSync('src/wallet/provider.ts', 'utf8')
if (/ccipRead:\s*false/.test(providerSource)) {
	pass('CCIP-read explicitly disabled on the public client')
} else {
	fail('src/wallet/provider.ts does not set ccipRead: false — contracts could trigger outbound fetches')
}

for (const note of noted) console.log(`  note  ${note}`)

if (failures === 0) {
	pass(`no unreviewed hosts or network APIs (explorer links allowed: ${[...ALLOWED_HOSTS].join(', ')})`)
	console.log('\nBundle talks only to the injected wallet provider.')
} else {
	console.log(`\n${failures} violation(s) found.`)
}
process.exit(failures === 0 ? 0 : 1)

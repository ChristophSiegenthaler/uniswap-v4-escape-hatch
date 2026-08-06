// Re-verifies every pinned address in src/chains/config.ts against the live chains.
//
// This is a DEV script. It is the only place in the repo that talks to a public
// RPC; the shipped application only ever uses the browser wallet's provider.
//
//   node scripts/verify-addresses.ts
//
// Exits non-zero if anything fails, so it can gate a build.

import { CHAINS, type ChainConfig, type Address } from '../src/chains/config.ts'
import { VERIFY_RPCS } from './verify-rpcs.ts'

const SEL = {
	symbol: '0x95d89b41',
	decimals: '0x313ce567',
	nextTokenId: '0x75794a3c',
	getSlot0: '0xc815641c',
	poolManager: '0xdc4c90d3',
} as const

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const pass = (msg: string) => console.log(`  ok    ${msg}`)

let nextId = 1
async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
		signal: AbortSignal.timeout(30_000),
	})
	const json = await res.json() as { result?: string; error?: { message: string } }
	if (json.error) throw new Error(json.error.message)
	if (json.result === undefined) throw new Error('no result')
	return json.result
}

const call = (url: string, to: Address, data: string) => rpc(url, 'eth_call', [{ to, data }, 'latest'])
const getCode = (url: string, address: Address) => rpc(url, 'eth_getCode', [address, 'latest'])

/** Decodes an ABI-encoded string, falling back to bytes32 (MKR-style tokens). */
function decodeString(hex: string): string {
	const body = hex.slice(2)
	if (body.length === 64) return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '')
	const len = parseInt(body.slice(64, 128), 16)
	return Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8')
}

// For each v4 contract the bytecode is byte-identical across chains. Recording the
// expected size turns "has code" into a much stronger check: a wrong-but-populated
// address almost certainly has a different size.
const EXPECTED_SIZES: Record<string, number> = {
	positionManager: 23877,
	stateView: 3531,
	quoter: 5820,
	universalRouter: 19499,
	permit2: 9152,
	multicall3: 3808,
}

// PoolManager sizes live in the chain config, because the app itself relies on
// them to identify which chain a fork is standing in for. Checking them here
// keeps that load-bearing value honest.
function expectedSize(chain: ChainConfig, contract: string): number | undefined {
	if (contract === 'poolManager') return chain.poolManagerCodeSize
	return EXPECTED_SIZES[contract]
}

async function verifyChain(chain: ChainConfig): Promise<void> {
	console.log(`\n=== ${chain.name} (chainId ${chain.chainId}) ===`)
	const rpcUrl = VERIFY_RPCS[chain.chainId]
	if (rpcUrl === undefined) return fail(`no dev RPC configured for chainId ${chain.chainId}`)

	try {
		const reported = parseInt(await rpc(rpcUrl, 'eth_chainId', []), 16)
		if (reported !== chain.chainId) return fail(`RPC reports chainId ${reported}, config says ${chain.chainId}`)
		pass(`chainId ${reported}`)
	} catch (err) {
		return fail(`unreachable: ${(err as Error).message}`)
	}

	for (const [name, address] of Object.entries(chain.contracts)) {
		try {
			const size = (await getCode(rpcUrl, address as Address)).length / 2 - 1
			if (size <= 0) { fail(`${name} ${address} has NO CODE`); continue }
			const expected = expectedSize(chain, name)
			if (expected !== undefined && size !== expected) {
				fail(`${name} ${address} is ${size}b, expected ${expected}b`)
				continue
			}
			pass(`${name} ${address} (${size}b)`)
		} catch (err) {
			fail(`${name} ${address}: ${(err as Error).message}`)
		}
	}

	// Functional probes: confirm the contracts actually answer the calls we depend
	// on, not merely that something is deployed there.
	try {
		const n = BigInt(await call(rpcUrl, chain.contracts.positionManager, SEL.nextTokenId))
		if (n < 1n) fail(`positionManager.nextTokenId() returned ${n}`)
		else pass(`positionManager.nextTokenId() = ${n}`)
	} catch (err) {
		fail(`positionManager.nextTokenId() reverted: ${(err as Error).message}`)
	}

	try {
		// getSlot0 on a nonexistent pool must return zeroes rather than revert --
		// pool discovery depends on that being how absent pools present.
		const empty = '00'.repeat(32)
		const out = await call(rpcUrl, chain.contracts.stateView, SEL.getSlot0 + empty)
		if (BigInt(out.slice(0, 66)) !== 0n) fail(`stateView.getSlot0(0x0) returned nonzero sqrtPrice`)
		else pass('stateView.getSlot0() answers, empty pool reads as zero')
	} catch (err) {
		fail(`stateView.getSlot0() reverted: ${(err as Error).message}`)
	}

	// Cross-check that the periphery contracts point at the PoolManager we pinned,
	// rather than trusting each address in isolation.
	for (const periphery of ['stateView', 'positionManager', 'quoter'] as const) {
		try {
			const out = await call(rpcUrl, chain.contracts[periphery], SEL.poolManager)
			const pointsAt = ('0x' + out.slice(-40)).toLowerCase()
			if (pointsAt !== chain.contracts.poolManager.toLowerCase()) {
				fail(`${periphery}.poolManager() = ${pointsAt}, config pins ${chain.contracts.poolManager}`)
			} else {
				pass(`${periphery}.poolManager() matches pinned PoolManager`)
			}
		} catch (err) {
			fail(`${periphery}.poolManager() reverted: ${(err as Error).message}`)
		}
	}

	for (const token of chain.baseTokens) {
		try {
			const [sym, dec] = await Promise.all([
				call(rpcUrl, token.address, SEL.symbol).then(decodeString),
				call(rpcUrl, token.address, SEL.decimals).then(h => parseInt(h, 16)),
			])
			if (sym !== token.symbol) fail(`${token.address} symbol is "${sym}", config says "${token.symbol}"`)
			else if (dec !== token.decimals) fail(`${token.symbol} decimals is ${dec}, config says ${token.decimals}`)
			else pass(`${token.symbol} ${token.address} (${dec} decimals)`)
		} catch (err) {
			fail(`token ${token.address}: ${(err as Error).message}`)
		}
	}
}

for (const chain of Object.values(CHAINS)) await verifyChain(chain)

console.log(failures === 0
	? '\nAll pinned addresses verified.'
	: `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

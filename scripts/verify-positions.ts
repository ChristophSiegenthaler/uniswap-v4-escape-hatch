// The emergency-exit drill.
//
// Forks mainnet, impersonates the real owner of a real position, and executes a
// real burn through the same encoder the app ships -- then checks the tokens
// actually arrived. Encoder bugs are the likely failure mode of this feature, and
// they are invisible to unit tests that only compare our output to itself.
//
// Includes a position in a HOOK pool, because that is the case the whole design
// hinges on: a pool we could never have discovered, exited from a token id alone.
//
// DEV ONLY. Spawns anvil and forks from a public RPC.
//
//   node scripts/verify-positions.ts

import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem'
import type { Address, PublicClient } from 'viem'
import { VERIFY_RPCS } from './verify-rpcs.ts'
import { viemChain } from '../src/wallet/chains.ts'
import { NATIVE_CURRENCY } from '../src/chains/config.ts'
import { erc20Abi, positionManagerAbi, stateViewAbi } from '../src/v4/abis.ts'
import { computePoolId } from '../src/v4/poolKey.ts'
import {
	buildExitTransaction, computeExitMinimums, estimatePositionValue, readPosition,
} from '../src/v4/positions.ts'
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from '../src/v4/math/tickMath.ts'

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const pass = (msg: string) => console.log(`  ok    ${msg}`)

const ANVIL_PORT = 8547
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`
const MAINNET_RPC = VERIFY_RPCS[1]!

/** Positions chosen from live mainnet state: one hookless, one in a hook pool. */
const CASES: readonly { tokenId: bigint; label: string }[] = [
	{ tokenId: 365000n, label: 'hookless pool (fee 50000, tickSpacing 500)' },
	{ tokenId: 365200n, label: 'HOOK pool (hook 0x38fdC1B7…)' },
]

// --- anvil -------------------------------------------------------------------

console.log('Starting anvil fork of mainnet...\n')
const anvil = spawn('anvil', [
	'--fork-url', MAINNET_RPC,
	'--port', String(ANVIL_PORT),
	'--silent',
	'--no-rate-limit',
], { stdio: ['ignore', 'ignore', 'pipe'] })

let anvilError = ''
anvil.stderr.on('data', chunk => { anvilError += String(chunk) })

const shutdown = () => { if (!anvil.killed) anvil.kill('SIGTERM') }
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(130) })

async function rpc(method: string, params: unknown[]): Promise<unknown> {
	const res = await fetch(ANVIL_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	})
	const json = await res.json() as { result?: unknown; error?: { message: string } }
	if (json.error) throw new Error(json.error.message)
	return json.result
}

async function waitForAnvil(): Promise<boolean> {
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			await rpc('eth_chainId', [])
			return true
		} catch {
			await new Promise(resolve => setTimeout(resolve, 1000))
		}
	}
	return false
}

if (!await waitForAnvil()) {
	console.log(`  FAIL  anvil did not start.${anvilError ? ` stderr: ${anvilError.slice(0, 300)}` : ''}`)
	process.exit(1)
}

const chain = viemChain(1)
const client = createPublicClient({ chain, transport: http(ANVIL_URL) }) as PublicClient
const wallet = createWalletClient({ chain, transport: http(ANVIL_URL) })

const block = await client.getBlockNumber()
pass(`anvil forked mainnet at block ${block}`)

// --- tick math against live pool state ---------------------------------------

console.log('\nTick math vs live pool state\n')
{
	// The defining invariant: the current price must sit in [tick, tick+1).
	// Checking it against real pools pins our port to the on-chain implementation.
	const usdc: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
	for (const [fee, tickSpacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const) {
		const poolId = computePoolId({
			currency0: NATIVE_CURRENCY, currency1: usdc, fee, tickSpacing,
			hooks: NATIVE_CURRENCY,
		})
		const slot0 = await client.readContract({
			address: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
			abi: stateViewAbi, functionName: 'getSlot0', args: [poolId],
		}) as readonly [bigint, number, number, number]

		const [sqrtPriceX96, tick] = slot0
		const lower = getSqrtPriceAtTick(tick)
		const upper = getSqrtPriceAtTick(tick + 1)
		if (sqrtPriceX96 >= lower && sqrtPriceX96 < upper) {
			pass(`fee ${fee}: sqrtPrice sits within [tick ${tick}, ${tick + 1})`)
		} else {
			fail(`fee ${fee}: sqrtPrice ${sqrtPriceX96} outside [${lower}, ${upper}) for tick ${tick}`)
		}

		if (getTickAtSqrtPrice(sqrtPriceX96) === tick) pass(`fee ${fee}: getTickAtSqrtPrice round-trips to ${tick}`)
		else fail(`fee ${fee}: getTickAtSqrtPrice gave ${getTickAtSqrtPrice(sqrtPriceX96)}, chain says ${tick}`)
	}
}

// --- the drill ---------------------------------------------------------------

async function balanceOf(currency: Address, holder: Address): Promise<bigint> {
	if (currency.toLowerCase() === NATIVE_CURRENCY) return client.getBalance({ address: holder })
	return client.readContract({
		address: currency, abi: erc20Abi, functionName: 'balanceOf', args: [holder],
	}) as Promise<bigint>
}

for (const { tokenId, label } of CASES) {
	console.log(`\nExit drill: tokenId ${tokenId} — ${label}\n`)

	const lookup = await readPosition(client, 1, tokenId, true)
	if (lookup.status !== 'found') {
		fail(`could not read position ${tokenId}: ${lookup.status}`)
		continue
	}
	const position = lookup.position

	if (position.keyVerified) pass('recovered PoolKey re-hashes to the stored pool id')
	else { fail('PoolKey did NOT verify — refusing to continue'); continue }

	const hooked = position.poolKey.hooks.toLowerCase() !== NATIVE_CURRENCY
	pass(`owner ${position.owner}, liquidity ${position.liquidity}, hooks ${hooked ? position.poolKey.hooks : 'none'}`)

	const estimate = await estimatePositionValue(client, 1, position)
	if (estimate === undefined) {
		console.log('        note: pool could not be priced; minimums would fall back to zero')
	} else {
		pass(`estimated principal: ${estimate.amount0} / ${estimate.amount1}`)
	}

	// 1% slippage floor, exactly as the UI will default.
	const minimums = computeExitMinimums(estimate, 100)

	const owner = position.owner
	await rpc('anvil_impersonateAccount', [owner])
	await rpc('anvil_setBalance', [owner, '0x56BC75E2D63100000']) // 100 ETH for gas

	const before0 = await balanceOf(position.poolKey.currency0, owner)
	const before1 = await balanceOf(position.poolKey.currency1, owner)

	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
	const tx = buildExitTransaction(1, {
		position, recipient: owner,
		amount0Min: minimums.amount0, amount1Min: minimums.amount1,
	}, deadline)

	if (tx === undefined) { fail('could not build exit transaction'); continue }

	try {
		const hash = await wallet.sendTransaction({
			account: owner, to: tx.to, data: tx.data, value: tx.value, chain,
			gas: 3_000_000n,
		})
		const receipt = await client.waitForTransactionReceipt({ hash })
		if (receipt.status === 'success') pass(`burn transaction succeeded (gas used ${receipt.gasUsed})`)
		else { fail('burn transaction reverted'); continue }
	} catch (error) {
		fail(`burn failed: ${(error as Error).message.split('\n')[0]}`)
		continue
	}

	const after0 = await balanceOf(position.poolKey.currency0, owner)
	const after1 = await balanceOf(position.poolKey.currency1, owner)

	const gained0 = after0 - before0
	const gained1 = after1 - before1
	// currency0 may be native ETH, in which case gas fees muddy the comparison.
	const isNative0 = position.poolKey.currency0.toLowerCase() === NATIVE_CURRENCY

	console.log(`        currency0 delta: ${gained0}${isNative0 ? ' (native, net of gas)' : ''}`)
	console.log(`        currency1 delta: ${gained1}`)

	if (gained0 > 0n || gained1 > 0n) {
		pass('tokens actually arrived in the owner\'s wallet')
	} else {
		fail('no tokens received — the exit encoded but did not pay out')
	}

	if (estimate !== undefined) {
		// The payout must cover principal; fees make it larger, never smaller.
		if (!isNative0 && estimate.amount0 > 0n && gained0 < minimums.amount0) {
			fail(`currency0 payout ${gained0} below the minimum we asked for ${minimums.amount0}`)
		} else if (estimate.amount1 > 0n && gained1 < minimums.amount1) {
			fail(`currency1 payout ${gained1} below the minimum we asked for ${minimums.amount1}`)
		} else {
			pass('payout met the slippage minimums we encoded')
		}
	}

	const remaining = await client.readContract({
		address: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
		abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId],
	}) as bigint
	if (remaining === 0n) pass('position liquidity is now zero')
	else fail(`position still holds ${remaining} liquidity`)

	await rpc('anvil_stopImpersonatingAccount', [owner])
}

console.log(failures === 0
	? '\nEmergency exit verified end to end on a mainnet fork, including a hook pool.'
	: `\n${failures} check(s) FAILED.`)

shutdown()
process.exit(failures === 0 ? 0 : 1)

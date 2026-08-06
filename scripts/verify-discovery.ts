// Exercises the M2 read layer against live mainnet.
//
// Unit tests over hand-written fixtures would only prove our encoder agrees with
// itself. This runs the real code against real pools, so a wrong pool id or a
// misread struct shows up as a mismatch rather than a green test.
//
// DEV ONLY -- uses a public RPC. The app never does.
//
//   node scripts/verify-discovery.ts

import { createPublicClient, http } from 'viem'
import type { Address, PublicClient } from 'viem'
import { VERIFY_RPCS } from './verify-rpcs.ts'
import { viemChain } from '../src/wallet/chains.ts'
import { CHAINS, NATIVE_CURRENCY } from '../src/chains/config.ts'
import { buildPoolKey, computePoolId, decodePositionInfo, truncatePoolId, unpackProtocolFee } from '../src/v4/poolKey.ts'
import { discoverPools, findRoutes } from '../src/v4/discover.ts'
import { fetchTokenMetadata } from '../src/tokens/metadata.ts'
import { positionManagerAbi } from '../src/v4/abis.ts'

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const pass = (msg: string) => console.log(`  ok    ${msg}`)

const MAINNET = CHAINS[1]!
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const MKR: Address = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2'

// Must pass the chain: viem reads the Multicall3 address from it, and without one
// every batched read silently degrades to sequential.
const client = createPublicClient({
	chain: viemChain(1),
	transport: http(VERIFY_RPCS[1]),
	ccipRead: false,
}) as PublicClient

// --- pool id derivation ------------------------------------------------------

console.log('Pool id derivation\n')
{
	// Pool ids computed independently with cast during M0.
	const known: readonly [number, number, string][] = [
		[100, 1, '0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7'],
		[500, 10, '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27'],
		[3000, 60, '0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d'],
		[10000, 200, '0xd934712639fede326a3ff8d2a9c2f73749bac510c23fb33443cea7f3c9aca6f3'],
	]
	for (const [fee, tickSpacing, expected] of known) {
		const key = buildPoolKey(NATIVE_CURRENCY, USDC, fee, tickSpacing)
		const actual = computePoolId(key)
		if (actual === expected) pass(`ETH/USDC ${fee}/${tickSpacing} -> ${actual.slice(0, 18)}...`)
		else fail(`ETH/USDC ${fee}/${tickSpacing}: got ${actual}, expected ${expected}`)
	}

	// Ordering must be independent of argument order.
	if (computePoolId(buildPoolKey(USDC, DAI, 500, 10)) === computePoolId(buildPoolKey(DAI, USDC, 500, 10))) {
		pass('currency ordering is argument-order independent')
	} else {
		fail('sortCurrencies did not normalise argument order')
	}

	// Native ETH must always sort into currency0.
	if (buildPoolKey(USDC, NATIVE_CURRENCY, 500, 10).currency0 === NATIVE_CURRENCY) {
		pass('native ETH sorts to currency0')
	} else {
		fail('native ETH did not sort to currency0')
	}
}

// --- discovery ---------------------------------------------------------------

console.log('\nDiscovery against live mainnet\n')
{
	const pools = await discoverPools(client, 1, NATIVE_CURRENCY, USDC, true)
	if (pools.length === 0) {
		fail('found no ETH/USDC pools')
	} else {
		pass(`found ${pools.length} hookless ETH/USDC pool(s)`)
		for (const pool of pools) {
			const fee = pool.poolKey.fee
			// The chain's own lpFee must agree with the fee we guessed in the key.
			if (pool.lpFee !== fee) fail(`pool ${fee}: chain reports lpFee ${pool.lpFee}`)
			const pf = pool.protocolFee
			console.log(`        fee=${fee} tick=${pool.tick} liquidity=${pool.liquidity} protocolFee=${pf.zeroForOne}/${pf.oneForZero}`)
		}
	}

	// A pair that certainly has no hookless pool at any canonical tier.
	const nonsense = await discoverPools(client, 1, MKR, '0x000000000000000000000000000000000000dEaD', true)
	if (nonsense.length === 0) pass('non-existent pair yields no pools (zero reads as absent, not an error)')
	else fail(`expected no pools for a nonsense pair, got ${nonsense.length}`)
}

// --- routing -----------------------------------------------------------------

console.log('\nRouting\n')
{
	const routes = await findRoutes(client, 1, USDC, DAI, true)
	if (routes.length === 0) {
		fail('no USDC -> DAI routes found')
	} else {
		pass(`found ${routes.length} USDC -> DAI route(s)`)
		const symbols = new Map<string, string>([
			[USDC.toLowerCase(), 'USDC'], [DAI.toLowerCase(), 'DAI'],
			[WETH.toLowerCase(), 'WETH'], [NATIVE_CURRENCY, 'ETH'],
		])
		for (const route of routes) {
			const path = route.path.map(a => symbols.get(a.toLowerCase()) ?? a.slice(0, 8)).join(' -> ')
			const fees = route.pools.map(p => p.poolKey.fee).join(',')
			console.log(`        ${path}  (fees ${fees})`)
		}
		if (routes.every(r => r.pools.every(p => p.liquidity > 0n))) {
			pass('every returned route has liquidity on all legs')
		} else {
			fail('a route was returned with an empty leg')
		}
	}
}

// --- token metadata ----------------------------------------------------------

console.log('\nToken metadata\n')
{
	const metadata = await fetchTokenMetadata(client, 1, [USDC, DAI, MKR, NATIVE_CURRENCY], true)

	const usdc = metadata.get(USDC.toLowerCase())
	if (usdc?.decimals === 6) pass(`USDC decimals read as ${usdc.decimals} (not assumed 18)`)
	else fail(`USDC decimals wrong: ${usdc?.decimals}`)

	// MKR returns bytes32 from symbol(), so this exercises the fallback path.
	const mkr = metadata.get(MKR.toLowerCase())
	if (mkr?.symbol === 'MKR') pass(`MKR symbol decoded from bytes32 as "${mkr.symbol}"`)
	else fail(`MKR bytes32 symbol fallback failed: got ${JSON.stringify(mkr?.symbol)}`)

	const native = metadata.get(NATIVE_CURRENCY)
	if (native?.isNative === true && native.decimals === 18) pass('native ETH handled without a contract call')
	else fail('native ETH metadata wrong')
}

// --- PositionInfo round trip -------------------------------------------------

console.log('\nPositionInfo unpacking against live positions\n')
{
	// 365000 is a live position; 340000 was burned and reads back as zero.
	for (const tokenId of [365000n, 340000n]) {
		const info = await client.readContract({
			address: MAINNET.contracts.positionManager,
			abi: positionManagerAbi,
			functionName: 'positionInfo',
			args: [tokenId],
		}) as bigint

		const decoded = decodePositionInfo(info)
		if (decoded.isEmpty) {
			pass(`tokenId ${tokenId}: reads as empty (burned or never minted)`)
			continue
		}

		const poolKey = await client.readContract({
			address: MAINNET.contracts.positionManager,
			abi: positionManagerAbi,
			functionName: 'poolKeys',
			args: [decoded.poolId],
		}) as readonly [Address, Address, number, number, Address]

		const [currency0, currency1, fee, tickSpacing, hooks] = poolKey
		if (currency1 === '0x0000000000000000000000000000000000000000' && currency0 === currency1) {
			fail(`tokenId ${tokenId}: poolKeys lookup returned an empty key`)
			continue
		}
		pass(`tokenId ${tokenId}: ticks ${decoded.tickLower}..${decoded.tickUpper}, pool ${currency0.slice(0, 8)}/${currency1.slice(0, 8)} fee=${fee} ts=${tickSpacing} hooks=${hooks === '0x0000000000000000000000000000000000000000' ? 'none' : hooks.slice(0, 10)}`)

		// The decisive check: the recovered PoolKey must hash back to the truncated
		// pool id the position stores. If this holds, the emergency exit can always
		// identify a position's pool from its token id alone.
		const rebuilt = truncatePoolId(computePoolId({ currency0, currency1, fee, tickSpacing, hooks }))
		if (rebuilt.toLowerCase() === decoded.poolId.toLowerCase()) {
			pass(`tokenId ${tokenId}: recovered PoolKey hashes back to the stored pool id`)
		} else {
			fail(`tokenId ${tokenId}: rebuilt ${rebuilt} != stored ${decoded.poolId}`)
		}
	}
}

// --- protocol fee unpacking --------------------------------------------------

console.log('\nProtocol fee unpacking\n')
{
	// Values observed live on the four ETH/USDC pools during M0.
	const cases: readonly [number, number, number][] = [
		[102425, 25, 25], [512125, 125, 125], [2048500, 500, 500], [4097000, 1000, 1000],
	]
	for (const [packed, expected0, expected1] of cases) {
		const { zeroForOne, oneForZero } = unpackProtocolFee(packed)
		if (zeroForOne === expected0 && oneForZero === expected1) pass(`${packed} -> ${zeroForOne}/${oneForZero}`)
		else fail(`${packed} -> ${zeroForOne}/${oneForZero}, expected ${expected0}/${expected1}`)
	}
}

console.log(failures === 0 ? '\nRead layer verified against mainnet.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

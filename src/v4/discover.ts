// Pool discovery without an indexer.
//
// v4 pools are keyed by PoolKey, so we can compute candidate pool ids locally and
// simply ask whether each one is initialised. That replaces the subgraph an
// interface would normally need.
//
// The honest limit: v4 does NOT constrain fee or tickSpacing to a canonical set.
// Live mainnet pools exist at (45,1), (150000,13) and (999950,76), none of which
// we probe. And a pool's hook can be any address, so hook pools are unenumerable
// by construction. This is therefore a heuristic that finds the deep, conventional
// pools where the volume is -- not an index, and it never pretends to be one.
// Anything outside it is reachable through manual PoolKey entry, and the
// emergency exit path does not depend on discovery at all.

import type { Address, Hex, PublicClient } from 'viem'
import { CANONICAL_FEE_TIERS, NATIVE_CURRENCY, getChain } from '../chains/config.ts'
import { stateViewAbi } from './abis.ts'
import { buildPoolKey, computePoolId, unpackProtocolFee } from './poolKey.ts'
import type { PoolKey, ProtocolFee } from './poolKey.ts'
import { batchRead } from './reads.ts'

export interface PoolState {
	readonly poolKey: PoolKey
	readonly poolId: Hex
	readonly sqrtPriceX96: bigint
	readonly tick: number
	readonly protocolFee: ProtocolFee
	/** The pool's own LP fee as reported by the chain, not the one we guessed. */
	readonly lpFee: number
	readonly liquidity: bigint
}

/**
 * Every hookless PoolKey we are willing to guess for a pair.
 *
 * Dynamic-fee pools are deliberately excluded: the dynamic fee flag requires a
 * hook with fee permissions, so a dynamic-fee pool with hooks = address(0) cannot
 * be initialised and probing for one would always waste a call.
 */
export function candidatePoolKeys(tokenA: Address, tokenB: Address): PoolKey[] {
	if (tokenA.toLowerCase() === tokenB.toLowerCase()) return []
	return CANONICAL_FEE_TIERS.map(({ fee, tickSpacing }) =>
		buildPoolKey(tokenA, tokenB, fee, tickSpacing, NATIVE_CURRENCY))
}

/**
 * Reads state for a set of candidate pools and returns only those that exist.
 *
 * An uninitialised pool reads back as all-zero rather than reverting (confirmed
 * on every supported chain by scripts/verify-addresses.ts), so sqrtPriceX96 == 0
 * is the existence test.
 */
export async function readPools(
	client: PublicClient,
	chainId: number,
	candidates: readonly PoolKey[],
	useMulticall: boolean,
): Promise<PoolState[]> {
	const chain = getChain(chainId)
	if (chain === undefined || candidates.length === 0) return []
	const stateView = chain.contracts.stateView

	const poolIds = candidates.map(computePoolId)
	// Interleaved so each pool's two reads stay adjacent and index maths is simple.
	const calls = poolIds.flatMap(poolId => ([
		{ address: stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] },
		{ address: stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId] },
	]))

	const results = await batchRead(client, calls, useMulticall)

	const pools: PoolState[] = []
	for (const [index, poolKey] of candidates.entries()) {
		const slot0 = results[index * 2]
		const liquidity = results[index * 2 + 1]
		if (slot0?.status !== 'success' || liquidity?.status !== 'success') continue

		const [sqrtPriceX96, tick, protocolFee, lpFee] =
			slot0.result as readonly [bigint, number, number, number]
		if (sqrtPriceX96 === 0n) continue // pool was never initialised

		const poolId = poolIds[index]
		if (poolId === undefined) continue

		pools.push({
			poolKey,
			poolId,
			sqrtPriceX96,
			tick,
			protocolFee: unpackProtocolFee(protocolFee),
			lpFee,
			liquidity: liquidity.result as bigint,
		})
	}
	return pools
}

/** Discovers hookless pools directly pairing two currencies. */
export async function discoverPools(
	client: PublicClient,
	chainId: number,
	tokenA: Address,
	tokenB: Address,
	useMulticall: boolean,
): Promise<PoolState[]> {
	return readPools(client, chainId, candidatePoolKeys(tokenA, tokenB), useMulticall)
}

export interface Route {
	/** Pools in swap order. One entry is a direct swap, two is a single hop. */
	readonly pools: readonly PoolState[]
	/** Currencies in swap order: [tokenIn, ...intermediates, tokenOut]. */
	readonly path: readonly Address[]
}

/**
 * Finds candidate routes from tokenIn to tokenOut.
 *
 * Direct pools, plus one hop through each of the chain's base tokens. This is a
 * small fixed search, not a pathfinder -- with no backend to run a graph search
 * on, a bounded fan-out we can resolve in one batched call is the right trade.
 * Routes are returned unranked; pricing them is M3's job.
 */
export async function findRoutes(
	client: PublicClient,
	chainId: number,
	tokenIn: Address,
	tokenOut: Address,
	useMulticall: boolean,
): Promise<Route[]> {
	const chain = getChain(chainId)
	if (chain === undefined) return []
	if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return []

	const intermediates = chain.baseTokens
		.map(token => token.address)
		.filter(address =>
			address.toLowerCase() !== tokenIn.toLowerCase() &&
			address.toLowerCase() !== tokenOut.toLowerCase())

	// One batch for everything: the direct pair and both legs of every hop.
	const directCandidates = candidatePoolKeys(tokenIn, tokenOut)
	const legCandidates = intermediates.flatMap(mid => [
		...candidatePoolKeys(tokenIn, mid),
		...candidatePoolKeys(mid, tokenOut),
	])

	const all = await readPools(client, chainId, [...directCandidates, ...legCandidates], useMulticall)

	const pairs = (a: Address, b: Address) => all.filter(pool => {
		const { currency0, currency1 } = pool.poolKey
		const lo = a.toLowerCase(), hi = b.toLowerCase()
		return (currency0.toLowerCase() === lo && currency1.toLowerCase() === hi) ||
			(currency0.toLowerCase() === hi && currency1.toLowerCase() === lo)
	})

	const routes: Route[] = []

	for (const pool of pairs(tokenIn, tokenOut)) {
		if (pool.liquidity > 0n) routes.push({ pools: [pool], path: [tokenIn, tokenOut] })
	}

	for (const mid of intermediates) {
		const first = pairs(tokenIn, mid).filter(p => p.liquidity > 0n)
		const second = pairs(mid, tokenOut).filter(p => p.liquidity > 0n)
		if (first.length === 0 || second.length === 0) continue
		// Deepest pool on each leg. Ranking every combination is M3's problem, and
		// quoting the full cross product would be needlessly expensive here.
		const bestFirst = first.reduce((a, b) => (b.liquidity > a.liquidity ? b : a))
		const bestSecond = second.reduce((a, b) => (b.liquidity > a.liquidity ? b : a))
		routes.push({ pools: [bestFirst, bestSecond], path: [tokenIn, mid, tokenOut] })
	}

	return routes
}

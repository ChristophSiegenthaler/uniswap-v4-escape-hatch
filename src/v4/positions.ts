// Reading and exiting Uniswap v4 liquidity positions.
//
// This is the reason the project exists: if app.uniswap.org is offline, censored
// or hostile, this path still gets your liquidity out.
//
// It is built to survive the most hostile conditions we can anticipate:
//
//   * It needs ONLY a token id. No indexer, no subgraph, no pool discovery, no
//     event history. PositionManager stores `mapping(bytes25 => PoolKey)`, and
//     BURN_POSITION takes no PoolKey argument, so a token id is sufficient to
//     fully identify and close a position.
//   * It works on hook pools, which cannot be enumerated at all.
//   * It uses only eth_call and eth_sendTransaction, the two methods every wallet
//     RPC supports.
//   * It VERIFIES the PoolKey it is handed. The recovered key is re-hashed and
//     compared against the pool id stored in the position, so a lying RPC cannot
//     substitute a different pool without being caught.

import { encodeAbiParameters, encodeFunctionData, encodePacked } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import { getChain } from '../chains/config.ts'
import { positionManagerAbi, stateViewAbi } from './abis.ts'
import { computePoolId, decodePositionInfo, truncatePoolId } from './poolKey.ts'
import type { PoolKey } from './poolKey.ts'
import { batchRead } from './reads.ts'
import { getSqrtPriceAtTick } from './math/tickMath.ts'
import { applySlippageFloor, getAmountsForLiquidity } from './math/liquidityAmounts.ts'
import type { TokenAmounts } from './math/liquidityAmounts.ts'

/** v4-periphery Actions, confirmed against the pinned upstream source. */
export const Actions = {
	DECREASE_LIQUIDITY: 0x01,
	BURN_POSITION: 0x03,
	TAKE_PAIR: 0x11,
	/**
	 * Routes a positive delta with a fallback cascade
	 * (LP -> defaultRecipient -> ERC-6909 mint). Intended for permissioned pools
	 * where the LP may be unable to receive the tokens directly.
	 *
	 * NOT wired up: we have not verified its parameter encoding against a live
	 * pool, and shipping an unverified escape hatch into an emergency tool would
	 * be worse than not offering it. Documented so it is not forgotten -- if
	 * TAKE_PAIR ever fails because a hook or token blocks the transfer, this is
	 * where to look.
	 */
	UNWIND_WITH_FALLBACK: 0x19,
} as const

export interface Position {
	readonly tokenId: bigint
	readonly owner: Address
	readonly poolKey: PoolKey
	/** The 25-byte pool id stored in the position. */
	readonly poolId: Hex
	readonly tickLower: number
	readonly tickUpper: number
	readonly liquidity: bigint
	readonly hasSubscriber: boolean
	/**
	 * True when the recovered PoolKey re-hashes to the stored pool id. If this is
	 * ever false, do not sign anything: the data did not come from the contract we
	 * think it did.
	 */
	readonly keyVerified: boolean
}

export type PositionLookup =
	| { readonly status: 'found'; readonly position: Position }
	/** Burned, or never minted. A normal state, not an error. */
	| { readonly status: 'empty'; readonly tokenId: bigint }
	| { readonly status: 'error'; readonly tokenId: bigint; readonly message: string }

/**
 * Reads everything needed to display and exit a position, from a token id alone.
 */
export async function readPosition(
	client: PublicClient,
	chainId: number,
	tokenId: bigint,
	useMulticall: boolean,
): Promise<PositionLookup> {
	const chain = getChain(chainId)
	if (chain === undefined) {
		return { status: 'error', tokenId, message: 'Unsupported chain.' }
	}
	const positionManager = chain.contracts.positionManager

	const [infoResult, liquidityResult, ownerResult] = await batchRead(client, [
		{ address: positionManager, abi: positionManagerAbi, functionName: 'positionInfo', args: [tokenId] },
		{ address: positionManager, abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId] },
		{ address: positionManager, abi: positionManagerAbi, functionName: 'ownerOf', args: [tokenId] },
	], useMulticall)

	if (infoResult?.status !== 'success') {
		return { status: 'error', tokenId, message: 'Could not read this position from the chain.' }
	}

	const info = decodePositionInfo(infoResult.result as bigint)
	if (info.isEmpty) return { status: 'empty', tokenId }

	const keyResult = await batchRead(client, [
		{ address: positionManager, abi: positionManagerAbi, functionName: 'poolKeys', args: [info.poolId] },
	], false)

	const entry = keyResult[0]
	if (entry?.status !== 'success') {
		return { status: 'error', tokenId, message: 'Could not resolve this position\'s pool.' }
	}

	const [currency0, currency1, fee, tickSpacing, hooks] =
		entry.result as readonly [Address, Address, number, number, Address]
	const poolKey: PoolKey = { currency0, currency1, fee, tickSpacing, hooks }

	// Re-derive the pool id from the key we were handed and compare. This is what
	// makes it safe to trust a single RPC we did not choose.
	const keyVerified =
		truncatePoolId(computePoolId(poolKey)).toLowerCase() === info.poolId.toLowerCase()

	return {
		status: 'found',
		position: {
			tokenId,
			owner: ownerResult?.status === 'success' ? ownerResult.result as Address : '0x0000000000000000000000000000000000000000',
			poolKey,
			poolId: info.poolId,
			tickLower: info.tickLower,
			tickUpper: info.tickUpper,
			liquidity: liquidityResult?.status === 'success' ? liquidityResult.result as bigint : 0n,
			hasSubscriber: info.hasSubscriber,
			keyVerified,
		},
	}
}

/**
 * Estimates the tokens a position would return, from current pool state.
 *
 * Principal only — a burn also collects accrued fees, so the real payout is at
 * least this. Returns undefined if the pool cannot be read, in which case the UI
 * must fall back to zero minimums and say so.
 */
export async function estimatePositionValue(
	client: PublicClient,
	chainId: number,
	position: Position,
): Promise<TokenAmounts | undefined> {
	const chain = getChain(chainId)
	if (chain === undefined) return undefined

	try {
		const slot0 = await client.readContract({
			address: chain.contracts.stateView,
			abi: stateViewAbi,
			functionName: 'getSlot0',
			args: [computePoolId(position.poolKey)],
		}) as readonly [bigint, number, number, number]

		const sqrtPriceX96 = slot0[0]
		if (sqrtPriceX96 === 0n) return undefined

		return getAmountsForLiquidity(
			sqrtPriceX96,
			getSqrtPriceAtTick(position.tickLower),
			getSqrtPriceAtTick(position.tickUpper),
			position.liquidity,
		)
	} catch {
		return undefined
	}
}

// --- exit encoding -----------------------------------------------------------

export interface ExitParams {
	readonly position: Position
	/** Where the tokens go. Normally the position's owner. */
	readonly recipient: Address
	readonly amount0Min: bigint
	readonly amount1Min: bigint
	/**
	 * Liquidity to remove. Omit to burn the position entirely, which also collects
	 * fees and destroys the NFT.
	 */
	readonly liquidity?: bigint
	readonly hookData?: Hex
}

const BURN_PARAMS = [
	{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' },
] as const

const DECREASE_PARAMS = [
	{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' },
] as const

const TAKE_PAIR_PARAMS = [{ type: 'address' }, { type: 'address' }, { type: 'address' }] as const

const UNLOCK_DATA_PARAMS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const

/**
 * Builds the `unlockData` for modifyLiquidities.
 *
 * Full exit:    BURN_POSITION  + TAKE_PAIR
 * Partial exit: DECREASE_LIQUIDITY + TAKE_PAIR
 *
 * TAKE_PAIR sweeps both currencies to the recipient, so native ETH arrives as ETH
 * rather than needing a separate unwrap.
 */
export function encodeExitData(params: ExitParams): Hex {
	const { position, recipient, amount0Min, amount1Min, liquidity, hookData = '0x' } = params
	const isFullExit = liquidity === undefined

	const actions = encodePacked(
		['uint8', 'uint8'],
		[isFullExit ? Actions.BURN_POSITION : Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR],
	)

	const modifyParams = isFullExit
		? encodeAbiParameters(BURN_PARAMS, [position.tokenId, amount0Min, amount1Min, hookData])
		: encodeAbiParameters(DECREASE_PARAMS, [position.tokenId, liquidity, amount0Min, amount1Min, hookData])

	const takeParams = encodeAbiParameters(TAKE_PAIR_PARAMS, [
		position.poolKey.currency0, position.poolKey.currency1, recipient,
	])

	return encodeAbiParameters(UNLOCK_DATA_PARAMS, [actions, [modifyParams, takeParams]])
}

export interface ExitTransaction {
	readonly to: Address
	readonly data: Hex
	readonly value: bigint
}

/** Builds the full transaction for an exit. Deadline is a unix timestamp. */
export function buildExitTransaction(
	chainId: number,
	params: ExitParams,
	deadline: bigint,
): ExitTransaction | undefined {
	const chain = getChain(chainId)
	if (chain === undefined) return undefined

	return {
		to: chain.contracts.positionManager,
		data: encodeFunctionData({
			abi: positionManagerAbi,
			functionName: 'modifyLiquidities',
			args: [encodeExitData(params), deadline],
		}),
		// Removing liquidity never sends value in.
		value: 0n,
	}
}

/** Computes slippage-bounded minimums, or zeros when the pool cannot be priced. */
export function computeExitMinimums(
	estimate: TokenAmounts | undefined,
	toleranceBps: number,
	fraction = 1,
): TokenAmounts {
	if (estimate === undefined) return { amount0: 0n, amount1: 0n }
	const scale = (value: bigint) =>
		applySlippageFloor((value * BigInt(Math.round(fraction * 10_000))) / 10_000n, toleranceBps)
	return { amount0: scale(estimate.amount0), amount1: scale(estimate.amount1) }
}

// --- remembering token ids ---------------------------------------------------
//
// The primary discovery path is the user telling us their token id, so the least
// we can do is not ask twice. Kept in localStorage per chain.

const STORAGE_PREFIX = 'uniswap-v4-escape-hatch:positions:'

export function loadRememberedTokenIds(chainId: number): bigint[] {
	try {
		const raw = localStorage.getItem(STORAGE_PREFIX + chainId)
		if (raw === null) return []
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((v): v is string => typeof v === 'string').map(BigInt)
	} catch {
		return []
	}
}

export function rememberTokenId(chainId: number, tokenId: bigint): void {
	try {
		const existing = loadRememberedTokenIds(chainId)
		if (existing.some(id => id === tokenId)) return
		const next = [...existing, tokenId].map(String)
		localStorage.setItem(STORAGE_PREFIX + chainId, JSON.stringify(next))
	} catch { /* private mode: remembering is a convenience, not a requirement */ }
}

export function forgetTokenId(chainId: number, tokenId: bigint): void {
	try {
		const next = loadRememberedTokenIds(chainId).filter(id => id !== tokenId).map(String)
		localStorage.setItem(STORAGE_PREFIX + chainId, JSON.stringify(next))
	} catch { /* ignore */ }
}

// --- optional discovery ------------------------------------------------------

/**
 * Finds positions by scanning an explicit token id range with ownerOf.
 *
 * Deliberately requires the user to choose the range. PositionManager is not
 * ERC721Enumerable and mainnet is past 365,000 token ids, so an exhaustive scan
 * is not a strategy -- but if you know roughly when you minted, a few thousand
 * ids resolve in a handful of batched calls. Stops early once balanceOf is
 * satisfied.
 */
export async function scanTokenIdRange(
	client: PublicClient,
	chainId: number,
	owner: Address,
	fromTokenId: bigint,
	toTokenId: bigint,
	useMulticall: boolean,
	onProgress?: (scanned: number, total: number) => void,
): Promise<bigint[]> {
	const chain = getChain(chainId)
	if (chain === undefined || toTokenId < fromTokenId) return []
	const positionManager = chain.contracts.positionManager

	const expected = await client.readContract({
		address: positionManager, abi: positionManagerAbi,
		functionName: 'balanceOf', args: [owner],
	}) as bigint
	if (expected === 0n) return []

	const found: bigint[] = []
	const total = Number(toTokenId - fromTokenId + 1n)
	const BATCH = 500n
	let scanned = 0

	for (let start = fromTokenId; start <= toTokenId; start += BATCH) {
		const end = start + BATCH - 1n > toTokenId ? toTokenId : start + BATCH - 1n
		const ids: bigint[] = []
		for (let id = start; id <= end; id++) ids.push(id)

		const results = await batchRead(client, ids.map(id => ({
			address: positionManager, abi: positionManagerAbi, functionName: 'ownerOf', args: [id],
		})), useMulticall)

		for (const [index, result] of results.entries()) {
			// ownerOf reverts for burned ids; a failure here is expected, not an error.
			if (result.status !== 'success') continue
			const id = ids[index]
			if (id !== undefined && (result.result as Address).toLowerCase() === owner.toLowerCase()) {
				found.push(id)
			}
		}

		scanned += ids.length
		onProgress?.(scanned, total)
		if (BigInt(found.length) >= expected) break
	}

	return found
}

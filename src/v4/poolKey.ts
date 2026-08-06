// PoolKey construction, pool id derivation, and PositionInfo unpacking.
//
// In v4 a pool is not a contract. It is state inside the singleton PoolManager,
// keyed by keccak256(abi.encode(PoolKey)). That is exactly why this app can work
// without an indexer: pool ids are computed locally, and read back with a plain
// eth_call. There is no factory to query and no event to scan.

import { encodeAbiParameters, keccak256 } from 'viem'
import type { Address, Hex } from 'viem'
import { NATIVE_CURRENCY } from '../chains/config.ts'

export interface PoolKey {
	/** The numerically lower of the two currencies. Native ETH (0x0) is always first. */
	readonly currency0: Address
	readonly currency1: Address
	/** LP fee in hundredths of a bip. May carry DYNAMIC_FEE_FLAG. */
	readonly fee: number
	readonly tickSpacing: number
	/** Zero address for a pool with no hook. */
	readonly hooks: Address
}

/** True if this currency is native ETH rather than an ERC-20. */
export function isNative(currency: Address): boolean {
	return currency.toLowerCase() === NATIVE_CURRENCY
}

/**
 * Orders two currencies as v4 requires. Comparison is numeric on the address, so
 * native ETH (the zero address) always sorts to currency0.
 */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
	return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

export function buildPoolKey(
	currencyA: Address,
	currencyB: Address,
	fee: number,
	tickSpacing: number,
	hooks: Address = NATIVE_CURRENCY,
): PoolKey {
	const [currency0, currency1] = sortCurrencies(currencyA, currencyB)
	return { currency0, currency1, fee, tickSpacing, hooks }
}

const POOL_KEY_PARAMS = [
	{ type: 'address' }, { type: 'address' },
	{ type: 'uint24' }, { type: 'int24' }, { type: 'address' },
] as const

/**
 * poolId = keccak256(abi.encode(poolKey)).
 *
 * PoolKey is a struct of only static types, so abi.encode(struct) is identical to
 * encoding the fields in order. Cross-checked against live mainnet pools in M0.
 */
export function computePoolId(key: PoolKey): Hex {
	return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [
		key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks,
	]))
}

/**
 * PositionManager stores pool keys under a 25-byte truncation of the pool id
 * (`mapping(bytes25 => PoolKey)`), so a position can name its pool in fewer bits.
 */
export function truncatePoolId(poolId: Hex): Hex {
	return poolId.slice(0, 2 + 50) as Hex
}

/** Whether the swap direction goes from currency0 to currency1. */
export function isZeroForOne(key: PoolKey, tokenIn: Address): boolean {
	return tokenIn.toLowerCase() === key.currency0.toLowerCase()
}

// --- protocol fee ------------------------------------------------------------

export interface ProtocolFee {
	/** Fee applied when swapping currency0 -> currency1, in hundredths of a bip. */
	readonly zeroForOne: number
	readonly oneForZero: number
}

/**
 * The protocolFee word from getSlot0 packs two 12-bit values.
 *
 * This matters for quoting: the protocol fee is taken off the INPUT before the LP
 * fee is applied, so ignoring it overstates the output. Observed live on mainnet
 * as 25/25, 125/125, 500/500 and 1000/1000 on the four ETH/USDC pools.
 */
export function unpackProtocolFee(packed: number): ProtocolFee {
	return { zeroForOne: packed & 0xfff, oneForZero: (packed >> 12) & 0xfff }
}

// --- PositionInfo ------------------------------------------------------------

export interface PositionInfo {
	/** 25-byte truncated pool id, ready to pass to PositionManager.poolKeys(). */
	readonly poolId: Hex
	readonly tickLower: number
	readonly tickUpper: number
	readonly hasSubscriber: boolean
	/**
	 * True when the packed word is zero, which means the position was burned or
	 * never existed. Rendering this as an error would be wrong -- it is a normal,
	 * expected state for any token id that has already been closed.
	 */
	readonly isEmpty: boolean
}

function toInt24(value: bigint): number {
	const masked = Number(value & 0xffffffn)
	return masked >= 0x800000 ? masked - 0x1000000 : masked
}

/**
 * Unpacks the word returned by PositionManager.positionInfo().
 *
 *   poolId (bytes25) = info >> 56
 *   tickUpper (int24) = info >> 32
 *   tickLower (int24) = info >> 8
 *   hasSubscriber     = info & 0xFF
 *
 * Verified against live mainnet positions in M0.
 */
export function decodePositionInfo(info: bigint): PositionInfo {
	if (info === 0n) {
		return { poolId: `0x${'00'.repeat(25)}`, tickLower: 0, tickUpper: 0, hasSubscriber: false, isEmpty: true }
	}
	const poolId = `0x${(info >> 56n).toString(16).padStart(50, '0')}` as Hex
	return {
		poolId,
		tickLower: toInt24(info >> 8n),
		tickUpper: toInt24(info >> 32n),
		hasSubscriber: (info & 0xffn) !== 0n,
		isEmpty: false,
	}
}

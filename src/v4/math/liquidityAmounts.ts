// Converts a position's liquidity into the token amounts it currently represents.
//
// Used to compute a sane amount0Min/amount1Min when exiting. Every division here
// rounds DOWN, deliberately: these numbers become slippage floors, and a floor
// that rounds up would occasionally exceed what the pool can actually pay and
// revert the exit -- the one outcome an emergency tool must not produce.

import { Q96 } from './tickMath.ts'

/** Token0 owed by `liquidity` across [sqrtA, sqrtB]. */
export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
	const [lower, upper] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB]
	if (lower === 0n) throw new Error('sqrt price must be non-zero')
	return ((liquidity << 96n) * (upper - lower)) / upper / lower
}

/** Token1 owed by `liquidity` across [sqrtA, sqrtB]. */
export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
	const [lower, upper] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB]
	return (liquidity * (upper - lower)) / Q96
}

export interface TokenAmounts {
	readonly amount0: bigint
	readonly amount1: bigint
}

/**
 * The token amounts a position holds at the current price.
 *
 * Below its range a position is entirely token0; above it, entirely token1; in
 * range it holds both. Note this is principal only — it does NOT include accrued
 * fees, which a burn also collects. Minimums derived from this are therefore
 * conservative, which is the right direction for a safety bound.
 */
export function getAmountsForLiquidity(
	sqrtPriceCurrent: bigint,
	sqrtPriceLower: bigint,
	sqrtPriceUpper: bigint,
	liquidity: bigint,
): TokenAmounts {
	const [lower, upper] = sqrtPriceLower > sqrtPriceUpper
		? [sqrtPriceUpper, sqrtPriceLower]
		: [sqrtPriceLower, sqrtPriceUpper]

	if (sqrtPriceCurrent <= lower) {
		return { amount0: getAmount0ForLiquidity(lower, upper, liquidity), amount1: 0n }
	}
	if (sqrtPriceCurrent < upper) {
		return {
			amount0: getAmount0ForLiquidity(sqrtPriceCurrent, upper, liquidity),
			amount1: getAmount1ForLiquidity(lower, sqrtPriceCurrent, liquidity),
		}
	}
	return { amount0: 0n, amount1: getAmount1ForLiquidity(lower, upper, liquidity) }
}

/**
 * Applies a slippage tolerance downward, for use as a minimum-received bound.
 *
 * @param toleranceBps tolerance in basis points; 100 = 1%
 */
export function applySlippageFloor(amount: bigint, toleranceBps: number): bigint {
	if (toleranceBps < 0 || toleranceBps > 10_000) throw new Error('tolerance must be 0..10000 bps')
	return (amount * BigInt(10_000 - toleranceBps)) / 10_000n
}

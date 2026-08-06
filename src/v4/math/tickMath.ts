// TickMath, ported from Uniswap v4-core.
//
// Transcribed from src/libraries/TickMath.sol at the pinned upstream source
// rather than from memory -- every magic constant below is a rounded fixed-point
// value where a single wrong digit produces prices that look plausible and are
// quietly wrong.
//
// Verified against live mainnet pools by the invariant
//   getSqrtPriceAtTick(tick) <= slot0.sqrtPriceX96 < getSqrtPriceAtTick(tick + 1)
// which pins the implementation against real chain state. See
// scripts/verify-positions.ts.

export const MIN_TICK = -887272
export const MAX_TICK = 887272

/** getSqrtPriceAtTick(MIN_TICK) */
export const MIN_SQRT_PRICE = 4295128739n
/** getSqrtPriceAtTick(MAX_TICK) */
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

export const Q96 = 1n << 96n

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Each set bit i of |tick| multiplies in 1/sqrt(1.0001^(2^i)) as a Q128.128.
 * Order matters and the shifts truncate, matching the on-chain arithmetic exactly.
 */
const RATIOS: readonly [bigint, bigint][] = [
	[0x2n, 0xfff97272373d413259a46990580e213an],
	[0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
	[0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
	[0x10n, 0xffcb9843d60f6159c9db58835c926644n],
	[0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
	[0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
	[0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
	[0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
	[0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
	[0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
	[0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
	[0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
	[0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
	[0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
	[0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
	[0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
	[0x20000n, 0x5d6af8dedb81196699c329225ee604n],
	[0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
	[0x80000n, 0x48a170391f7dc42444e8fa2n],
]

/** The sqrt price at a tick, as a Q64.96. */
export function getSqrtPriceAtTick(tick: number): bigint {
	const absTick = BigInt(Math.abs(tick))
	if (absTick > BigInt(MAX_TICK)) throw new Error(`tick ${tick} out of range`)

	let price = (absTick & 0x1n) !== 0n
		? 0xfffcb933bd6fad37aa2d162d1a594001n
		: 1n << 128n

	for (const [bit, ratio] of RATIOS) {
		if ((absTick & bit) !== 0n) price = (price * ratio) >> 128n
	}

	// Positive ticks are the reciprocal of the negative-tick product.
	if (tick > 0) price = MAX_UINT256 / price

	// Q128.128 -> Q128.96, rounding UP so that getTickAtSqrtPrice round-trips.
	return (price + 0xffffffffn) >> 32n
}

/**
 * The greatest tick whose sqrt price is <= the given price.
 *
 * Implemented as a binary search rather than a port of the log2 bit-twiddling.
 * At ~21 iterations over an exact integer comparison it is fast enough for UI
 * work, and it is correct by construction against getSqrtPriceAtTick -- there is
 * no second set of constants to get subtly wrong.
 */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
	if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 > MAX_SQRT_PRICE) {
		throw new Error(`sqrt price ${sqrtPriceX96} out of range`)
	}
	let low = MIN_TICK
	let high = MAX_TICK
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) low = mid
		else high = mid - 1
	}
	return low
}

/** Rounds a tick down to a multiple of tickSpacing, toward negative infinity. */
export function alignTick(tick: number, tickSpacing: number): number {
	return Math.floor(tick / tickSpacing) * tickSpacing
}

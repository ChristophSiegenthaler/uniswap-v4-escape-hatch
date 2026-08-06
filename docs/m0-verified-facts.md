# M0: onchain-verified facts

Everything here was confirmed by calling mainnet, not read from documentation.
Re-check with `node scripts/verify-addresses.ts`.

## StateView.getSlot0

```
getSlot0(bytes32 poolId) returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
```

The fee fields are **`uint24`, not `uint8`** — the Uniswap docs are wrong on this.
Proved empirically: the ETH/USDC 1% pool returns `lpFee = 10000`, which cannot fit
in a `uint8`.

Live readings, ETH/USDC hookless pools on mainnet:

| fee | tickSpacing | lpFee | protocolFee | liquidity |
|---|---|---|---|---|
| 100 | 1 | 100 | 102425 | 9.91e16 |
| 500 | 10 | 500 | 512125 | 3.52e17 |
| 3000 | 60 | 3000 | 2048500 | 9.26e17 |
| 10000 | 200 | 10000 | 4097000 | 8.68e14 |

**`protocolFee` packs two 12-bit values**: `protocolFee & 0xFFF` is the fee for
zeroForOne, `protocolFee >> 12` for oneForZero. In all four pools above both halves
are equal (25/25, 125/125, 500/500, 1000/1000). The protocol fee is taken off the
input *before* the LP fee — M3 quote math must apply both, in that order.

An absent pool reads back as all-zero rather than reverting. Pool discovery relies
on this.

## V4Quoter

```
quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
  returns (uint256 amountOut, uint256 gasEstimate)
```

Note the parameter is a *flat* tuple `(PoolKey, zeroForOne, exactAmount, hookData)` —
the PoolKey is not double-wrapped.

Works over plain `eth_call` despite being state-mutating. 1 ETH → USDC on the 500/10
pool returned **1905.12 USDC with `gasEstimate` 42439** — cheap enough that wallet
`eth_call` gas caps are not a concern for single-hop preflight. Cross-checks against
the `sqrtPriceX96` reading (~$1907 spot, difference = fee + price impact), which
independently validates our slot0 decoding.

## PositionInfo packing

`positionInfo(uint256 tokenId) returns (uint256)`, packed as:

```
poolId (bytes25)  = info >> 56
tickUpper (int24) = int24(info >> 32)
tickLower (int24) = int24(info >> 8)
hasSubscriber     = info & 0xFF
```

Verified against three live mainnet positions.

**A burned or never-minted position returns `0`**, and `poolKeys()` on the resulting
zero pool ID returns an all-zero PoolKey. The UI must render this as "position
already closed", not crash. Token IDs 340000, 360000, 363000 and 364000 are all in
this state and make good fixtures.

## The emergency-exit chain (the critical path)

```
tokenId → positionInfo() → poolId (bytes25) → poolKeys() → full PoolKey
```

`poolKeys` is `mapping(bytes25 => PoolKey)` and `BURN_POSITION` takes only
`(tokenId, amount0Min, amount1Min, hookData)` — **no PoolKey argument**. So a token
ID alone is sufficient to fully exit, with no pool discovery and no indexer. Proved
end to end on live mainnet positions, including ones in hook pools.

## Fee tiers are unconstrained

Unlike v3, v4 puts fee and tickSpacing in the PoolKey with no canonical set.
Real pools sampled from recent mainnet positions:

| fee | tickSpacing | note |
|---|---|---|
| 10 | 1 | USDC/USDT |
| 45 | 1 | USDe/USDT |
| 0 | 200 | with hook |
| 31800 | 10 | |
| 50000 | 500 | |
| 150000 | 13 | 15% fee |
| 999950 | 76 | 99.995% fee |

None appear in the canonical `(100,1) (500,10) (3000,60) (10000,200)` set. Discovery
by enumeration is therefore a heuristic for finding deep pools, never a complete
index. This is a documented limitation, and it does not affect the exit path.

## Hook pools are common

Of seven resolvable positions sampled, **three were in hook pools**. Hook-pool
liquidity is not a marginal case, which reinforces both the manual-PoolKey escape
hatch and the value of an exit path that works without discovery.

## Actions constants

Confirmed against `v4-periphery/src/libraries/Actions.sol`. Relevant ones:

```
DECREASE_LIQUIDITY   0x01
BURN_POSITION        0x03
SWAP_EXACT_IN_SINGLE 0x06
SETTLE_PAIR          0x0d
TAKE_ALL             0x0f
TAKE_PAIR            0x11
UNWIND_WITH_FALLBACK 0x19
```

`INCREASE_LIQUIDITY_FROM_DELTAS` (0x04) and `MINT_POSITION_FROM_DELTAS` (0x05) are
marked **DEPRECATED — vulnerable to sandwich attacks**. Do not use.

`UNWIND_WITH_FALLBACK` is documented as: *"permissioned-pools specific … routes a
currency's positive delta with a fallback cascade: LP → defaultRecipient → 6909 mint
to defaultRecipient."* It is for permissioned pools where the LP may be unable to
receive the tokens. Relevant to M5 as a last-resort exit when `TAKE_PAIR` cannot
deliver: the value can still be rescued as an ERC-6909 claim.

## Deployment addresses

Bytecode is byte-identical across chains per contract (PoolManager 24009b,
PositionManager 23877b, StateView 3531b, V4Quoter 5820b, UniversalRouter 19499b,
Permit2 9152b, Multicall3 3808b).

**Exception:** Unichain's PoolManager (`0x1f98400000000000000000000000000000000004`)
is 24050b — a distinct build. It is correctly wired: all three periphery contracts
there return it from `poolManager()`.

Multicall3 is at `0xcA11bde05977b3631167028862bE2a173976CA11` on all five chains,
so the batching strategy in M2 holds everywhere.

Arbitrum's bridged Tether at `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` reports
its symbol as `USD₮0`, not `USDT`.

# Emergency exit

**If Uniswap's interface is unavailable, you can still withdraw your liquidity.
You need one thing: your position id.**

## The procedure

1. Open this app and connect your wallet.
2. Find your position id — the token id of your Uniswap v4 NFT. Your wallet's NFT
   list shows it, or any block explorer will, under the PositionManager contract.
   **You do not need Uniswap's website for this step.**
3. Enter the id and press *Look up position*.
4. Check the pool, range and owner shown are what you expect.
5. Press *Withdraw all liquidity* and confirm in your wallet.

That is the whole path. It does not use an indexer, a subgraph, a price API, or
any server. It talks to your wallet's RPC and nothing else.

## Why a position id is enough

`PositionManager` stores `mapping(bytes25 poolId => PoolKey)`, and the
`BURN_POSITION` action takes only `(tokenId, amount0Min, amount1Min, hookData)` —
**no PoolKey argument**. So from a token id alone we can:

```
tokenId → positionInfo() → 25-byte poolId → poolKeys() → the full PoolKey
```

This has two consequences that matter under duress:

- **No discovery is required.** We never have to find your pool; the position
  names it.
- **It works on hook pools**, which cannot be enumerated by any means. Verified by
  burning a real hook-pool position on a mainnet fork.

## We verify the pool, we do not trust it

The recovered `PoolKey` is re-hashed and compared against the pool id stored in
the position. If they disagree, the UI refuses to build a transaction and says so.

This matters because the app deliberately has exactly one source of chain data:
whatever RPC your wallet is pointed at. That endpoint is not ours and we did not
choose it. Re-deriving the pool id makes a substituted pool detectable rather than
something you would sign blind.

## Slippage, and the escape hatch

By default the exit asks for at least your position's principal minus a 1%
tolerance, computed locally from the pool's current price using ported
`TickMath` and `LiquidityAmounts`. Because a burn also collects accrued fees, the
real payout is normally larger — in the fork drill, ~7% above the estimate.

There is a **Get me out regardless** checkbox that sets both minimums to zero. It
is not the default and it is labelled as dangerous, because it invites a
sandwicher to take most of the value. It exists because "I lost some to MEV" beats
"I could not withdraw at all", and only you can judge which situation you are in.

If the pool's price cannot be read at all, minimums fall back to zero and the UI
says so explicitly rather than pretending it protected you.

## Known gaps

- **Partial withdrawals** are encoded (`DECREASE_LIQUIDITY`) but not yet exposed
  in the UI. Full exit only for now.
- **`UNWIND_WITH_FALLBACK` (0x19)** is not wired up. It routes a positive delta
  through a fallback cascade (LP → defaultRecipient → ERC-6909 mint) and is meant
  for permissioned pools where the LP cannot receive tokens directly. If
  `TAKE_PAIR` ever fails because a hook or token blocks the transfer, that is the
  escape hatch to reach for. We have not verified its encoding against a live
  pool, and shipping an unverified escape hatch would be worse than not offering
  one.
- **Finding positions you have forgotten.** `PositionManager` is not
  `ERC721Enumerable` and mainnet is past 365,000 token ids, so there is no cheap
  "list my positions". `scanTokenIdRange()` exists for an explicit id range if you
  know roughly when you minted, and `eth_getLogs` discovery is possible when your
  RPC supports it. Neither is required for the exit itself.

## Verification

### Executed on Ethereum mainnet

The exit has been run for real — not only on a fork. A live position was closed
from this interface by a browser wallet signing an ordinary transaction:

| | |
|---|---|
| Transaction | [`0x0bd6c8b3d2cc9f1893493aca5848d8e91da6bf2028c571a07dce4d4ff87d3ed6`](https://etherscan.io/tx/0x0bd6c8b3d2cc9f1893493aca5848d8e91da6bf2028c571a07dce4d4ff87d3ed6) |
| Block | 25703139 |
| Position | tokenId 365942, ETH/WBTC |
| Actions | `0x0311` — `BURN_POSITION` + `TAKE_PAIR` |
| Result | success, 147,057 gas |

Both legs cleared the minimums the app computed locally from pool state:

| | minimum encoded | received |
|---|---|---|
| ETH | 0.002072754131654238 | **0.002093691042074988** |
| WBTC | 0.00006469 | **0.00006535** |

`positionInfo` for 365942 now reads `0` — the position is burned.

This validates more than the burn succeeding. The slippage floor was derived by
the ported `TickMath` and `LiquidityAmounts` in this repo, encoded into the
calldata, and enforced by the contract — and both legs landed above it, the
excess being accrued fees. The locally-computed-minimum design is confirmed
against mainnet, not just against a fork.

The ETH leg needed an indirect check: native currency emits no `Transfer` event,
so it was confirmed from the sender's balance delta across the block with the
gas cost added back.

### On a fork

`npm run verify:positions` forks mainnet, impersonates the real owners of two real
positions — one hookless, one in a hook pool — and burns them through the same
encoder the app ships, asserting that the tokens actually arrive, that the payout
meets the encoded minimums, and that the position's liquidity ends at zero.

Latest run:

```
Exit drill: tokenId 365000 — hookless pool (fee 50000, tickSpacing 500)
  ok  recovered PoolKey re-hashes to the stored pool id
  ok  burn transaction succeeded (gas used 155462)
  ok  tokens actually arrived in the owner's wallet
  ok  payout met the slippage minimums we encoded
  ok  position liquidity is now zero

Exit drill: tokenId 365200 — HOOK pool (hook 0x38fdC1B7…)
  ok  recovered PoolKey re-hashes to the stored pool id
  ok  burn transaction succeeded (gas used 174615)
  ok  tokens actually arrived in the owner's wallet
  ok  payout met the slippage minimums we encoded
  ok  position liquidity is now zero
```

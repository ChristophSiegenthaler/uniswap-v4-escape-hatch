# Uniswap v4 Escape Hatch

A Uniswap v4 interface that talks **only to your browser wallet's RPC**. No
backend, no indexer, no subgraph, no price API, no WalletConnect relay. A static
bundle that runs from IPFS or `file://`.

Built in the spirit of [Horswap](https://github.com/DarkFlorist/Horswap), but for
Uniswap protocol v4 and from scratch — Horswap is a fork of the Uniswap Interface,
which is v2/v3-shaped and does not map onto v4.

## Why it exists

1. A v4 swap UI that depends on nothing but your wallet.
2. **An emergency exit for your own LP positions.** If `app.uniswap.org` is
   offline, censored, or hostile, this still pulls your liquidity out. Correctness
   here matters more than the swap path.

The exit works because of a v4 detail: `PositionManager.poolKeys` maps
`bytes25 → PoolKey`, and `BURN_POSITION` takes no PoolKey argument. **A position's
token ID alone is enough to fully exit it** — no pool discovery, no indexer, and it
works on hook pools you could never enumerate.

## Status

Milestones 0–2 and 5 complete. **The emergency LP exit works and is verified by
burning real positions on a mainnet fork, including one in a hook pool** — see
[`docs/emergency-exit.md`](docs/emergency-exit.md).

Swap execution (M3/M4) is not implemented yet.

## Try it

Two ways, depending on how far you want to go.

**Just look at it** — no wallet needed:

```sh
npm install
npm run dev     # http://127.0.0.1:8000
```

You get the disconnected state. Connect a browser wallet on any supported chain
and you can read any position by id and search for pools, against real chain
data. Read-only: nothing is signed.

**Actually withdraw a position** — the real thing, on a local fork of mainnet:

```sh
node scripts/dev-fork.ts --to 0xYourWalletAddress   # terminal 1, keep running
npm run dev                                         # terminal 2
```

The first command forks mainnet and **transfers a real, funded v4 position to
your address on the fork**, so you sign with your own wallet and never import a
test private key. It prints the position id and the network settings to add.
Pass `--token-id 365200` to get one in a hook pool instead.

The fork reports **chain ID 31337**, not 1. Anvil normally adopts the forked
chain's id, but no wallet will accept a second network claiming to be Ethereum —
so it is overridden. The app then identifies what was forked by probing which
PoolManager has bytecode, and shows a banner saying so.

Add the network **and select it**. If your wallet stays on mainnet you will be
reading mainnet, and the position will correctly appear to belong to someone
else. Nothing you do on the fork touches the real chain, and it vanishes on
Ctrl-C.

## Development

```sh
npm install
npm run dev      # esbuild watch + local server
npm run check    # typecheck, build, network audit, smoke tests
```

Scripts:

- `verify:addresses` — re-checks every pinned contract address against five live
  chains: bytecode present, expected size, periphery wired to the pinned
  PoolManager, base-token symbols and decimals.
- `verify:no-network` — fails the build if the bundle references any host outside
  a reviewed allowlist, or uses a network API it shouldn't.
- `verify:discovery` — runs the read layer against live mainnet: pool ids match
  independently computed values, discovery finds the real ETH/USDC pools, routing
  returns funded paths, and a live position's recovered PoolKey hashes back to the
  pool id stored in it.
- `verify:positions` — the emergency-exit drill: forks mainnet, impersonates the
  real owners of two real positions (one hookless, one in a hook pool) and burns
  them through the shipping encoder, asserting the tokens arrive.
- `test` — renders the built bundle in jsdom and drives it with a mock EIP-6963
  wallet across five scenarios, including the emergency-exit flow.

The `verify:*` scripts under `npm run verify:onchain` are the only things in the
repo that contact a public RPC, and they import their endpoints from
`scripts/verify-rpcs.ts`, which application code must never import. The shipped
application talks to nothing but the user's wallet — enforced by
`verify:no-network`, not merely intended.

## Known limitations

- **Mobile: in-app browsers only.** Deep-linking to a wallet app needs
  WalletConnect, whose relay is a third-party server.
- **ENS on mainnet only.** Reverse resolution lives on L1; resolving it from an L2
  would need either a mainnet endpoint we don't have or a CCIP-read gateway.
- **Pool discovery is a heuristic, not an index.** v4 puts fee and tickSpacing in
  the PoolKey with no canonical set — real pools exist at `(45,1)`, `(150000,13)`,
  `(999950,76)`. We probe the deep conventional tiers and offer manual PoolKey
  entry for everything else. The emergency exit never relies on discovery.
- **Without a wallet the app shows nothing.** Intentional — the alternative is
  quietly calling someone else's server.

## Docs

- [`docs/m0-verified-facts.md`](docs/m0-verified-facts.md) — onchain-verified ABI
  and packing details, and where the official docs are wrong.
- [`docs/emergency-exit.md`](docs/emergency-exit.md) — how to withdraw your
  liquidity when Uniswap's site is unavailable, and why a position id is enough.
- [`docs/ethskills-compliance.md`](docs/ethskills-compliance.md) — which external
  guidance was followed, deviated from, and why.

## Hosting

The build output is a static bundle with relative asset paths and no router, so
it will serve from anywhere: IPFS, a plain file server, or `file://`.

A GitHub Actions workflow publishes every push to `main` to GitHub Pages, gated
on `npm run check` — so a bundle that reaches an unreviewed host, or crashes on
first paint, never gets published.

**Be clear about what that hosting is worth.** GitHub Pages is a centralised
host that can take the page down, and a DNS name is a censorship point. It is a
convenience mirror, not the censorship-resistant answer. The properties this
project actually guarantees are in the bundle, not the hosting: no backend, no
indexer, no third-party RPC. Save the page locally and it still works; that is
the real fallback, and it is why the app runs from `file://`.

IPFS deployment is the aligned option and is not wired up yet.

## Licence

MIT — see [LICENSE](LICENSE). Permissive on purpose: a tool meant to be a fallback
should be forkable, mirrorable and re-hostable by anyone, without asking.

Not affiliated with Uniswap Labs, or with DarkFlorist's Horswap.

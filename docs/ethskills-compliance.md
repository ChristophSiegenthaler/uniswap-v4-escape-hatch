# ETHSKILLS reconciliation

Checked `frontend-ux/`, `qa/`, `wallets/`, `frontend-playbook/` and `orchestration/`
against M1. Recorded here so deviations are deliberate and reviewable rather than
accidental.

## Followed

| Guidance | Where |
|---|---|
| Connect must be a **button**, never a paragraph (ship-blocker) | `components/PrimaryAction.tsx` |
| Wrong network → primary action becomes "Switch to X" (ship-blocker) | `components/PrimaryAction.tsx`, covered by smoke scenario 3 |
| One button at a time: connect → network → approve → act | `components/PrimaryAction.tsx` |
| Network check **before** approval check | `PrimaryAction` returns the switch button before considering `approval` |
| Double-submit needs **two** flags, not just `isPending` | `components/TxButton.tsx` — `submitting` + `cooling` |
| Pending state always cleared in `finally {}` | `TxButton.handle()` |
| Inline spinner beside the label, not replacing button content | `.spinner` in `styles.css` |
| Semantic theme tokens, no hardcoded dark backgrounds | `styles.css`, light + dark via `prefers-color-scheme` |
| Translate contract/wallet errors, never show raw selectors | `wallet/errors.ts` |
| Responsive polling (2–5s), watch for runaway QPS | `provider.ts` polls blocks at 5s; one poll drives all refreshes |
| Address display: checksummed, truncated, copy, explorer link | `components/Address.tsx` |
| Checksum addresses via `getAddress` | `provider.ts` on connect, `Address.tsx` on render |
| Never commit secrets | `.gitignore` |
| Own tab title and favicon, no template branding | `index.html` |

## Deliberate deviations

**Scaffold-ETH 2 / Next.js / RainbowKit / wagmi / DaisyUI.** The playbook's whole
stack is rejected in favour of Preact + viem + esbuild. SE2 is a monorepo for
projects that *deploy contracts*; we deploy none. Its `yarn fork` workflow, contract
auto-generation and three-phase pipeline have nothing to act on here. The bundle is
337 KB, loads from `file://`, and has no framework runtime to audit. Consequently
the QA checklist's SE2-specific items — grep commands, `deployedContracts.ts`,
burner wallet mode, BuidlGuidl footer, DaisyUI radius — do not apply.

**Contract verification (ship-blocker #5)** is not applicable and is a *feature*:
we deploy no contracts, so there is no unverified code, no admin key and no upgrade
path. Everything we touch is Uniswap's own audited deployment.

**RainbowKit connector list / "include Phantom" (#15).** We satisfy the intent
better via EIP-6963: every injected wallet announces itself, so Phantom, Rabby,
Frame and anything else appear with no allowlist for us to maintain and forget.

**WalletConnect and mobile deep-linking (#16)** are out. WalletConnect is a relay
server — precisely the third-party dependency this project exists to remove. The
honest cost: **mobile works only inside a wallet's in-app browser.** That is a real
limitation and belongs in the README.

**USD values (#10)** are planned for M3 via an onchain USDC quote, as Horswap does.
No price API, so no fiat display on chains where we cannot find a USDC route.

## Forced by the zero-server constraint

**ENS resolution (Rule 3 / QA #9) is only possible on mainnet.** Reverse resolution
lives on L1, so a user on Base or Arbitrum would need a mainnet endpoint we do not
have — their wallet is pointed at the chain they are on. Cross-chain ENS via
CCIP-read requires a gateway server. So ENS lands in M2 for mainnet only; elsewhere
a checksummed address is the honest answer, not a name we cannot verify. Documented
in `components/Address.tsx`.

## Found by following the guidance

Auditing the bundle for outside network access (`scripts/check-no-network.ts`)
turned up something none of the checklists mention: **viem enables CCIP-read by
default**. When a contract reverts with `OffchainLookup`, viem fetches a URL *the
contract chose*, leaking the user's IP and the address being queried to an
arbitrary gateway — an outbound request triggered by chain data, not by our code.
Now disabled explicitly in `provider.ts`, and asserted by the check script so it
cannot regress.

## Still outstanding

- **CROPS review (ship-blocker #6)** — due before shipping. Much of it is unusually
  easy to answer here (no admin keys, no custody, no hosted infrastructure), and
  the "user's exit mechanism" question is the entire point of M5.
- **OG metadata (#11)** wants absolute URLs, which sits awkwardly with IPFS
  content-addressing. Resolve at M6.

// ENS reverse resolution, mainnet only.
//
// Reverse records live on L1. A user connected to Base or Arbitrum would need a
// mainnet endpoint to read them, and the only endpoint we have is their wallet --
// which is pointed at the chain they are on. Cross-chain ENS via CCIP-read needs
// a gateway server, which is the dependency this project exists to avoid.
//
// So: names resolve on mainnet, and everywhere else we show a checksummed
// address. An address is honest; a name we cannot verify is not.
//
// Second, narrower limit: CCIP-read is disabled on our client (see provider.ts),
// so names served by an *offchain* resolver will not resolve even on mainnet.
// Verified against mainnet that ordinary onchain names still resolve fine with
// ccipRead off. Failure here is never surfaced as an error -- we just show the
// address.

import { signal } from '@preact/signals'
import type { Address, PublicClient } from 'viem'

const MAINNET_CHAIN_ID = 1

/** Resolved names by lowercased address. A miss is cached as null, so we ask once. */
const cache = new Map<Address, string | null>()

export const ensNames = signal<ReadonlyMap<Address, string | null>>(new Map())

export function ensNameFor(address: Address): string | undefined {
	return ensNames.value.get(address.toLowerCase() as Address) ?? undefined
}

export async function resolveEnsName(
	client: PublicClient,
	chainId: number,
	address: Address,
): Promise<void> {
	if (chainId !== MAINNET_CHAIN_ID) return
	const key = address.toLowerCase() as Address
	if (cache.has(key)) return

	// Claim the slot before awaiting so concurrent callers do not duplicate work.
	cache.set(key, null)
	try {
		const name = await client.getEnsName({ address })
		cache.set(key, name)
	} catch {
		// Offchain resolver, unsupported RPC, or no reverse record. All the same to
		// us: fall back to the address silently.
		cache.set(key, null)
	}
	ensNames.value = new Map(cache)
}

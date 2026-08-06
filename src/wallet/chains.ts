// viem Chain objects built from our own pinned config.
//
// Deliberately not imported from viem/chains: those carry public HTTP RPC URLs,
// which would be bundled into the app. We define chains ourselves with an empty
// rpcUrls list, because the transport is always the wallet -- viem never dials
// out on its own.

import { defineChain } from 'viem'
import type { Chain } from 'viem'
import { CHAINS } from '../chains/config.ts'

const chainCache = new Map<number, Chain>()

export function viemChain(chainId: number): Chain | undefined {
	const cached = chainCache.get(chainId)
	if (cached !== undefined) return cached

	const config = CHAINS[chainId]
	if (config === undefined) return undefined

	const chain = defineChain({
		id: config.chainId,
		name: config.name,
		nativeCurrency: { name: 'Ether', symbol: config.nativeSymbol, decimals: 18 },
		// Empty on purpose. The wallet provides transport; we never hold an endpoint.
		rpcUrls: { default: { http: [] } },
		contracts: { multicall3: { address: config.contracts.multicall3 } },
	})
	chainCache.set(chainId, chain)
	return chain
}

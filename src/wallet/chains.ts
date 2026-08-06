// viem Chain objects built from our own pinned config.
//
// Deliberately not imported from viem/chains: those carry public HTTP RPC URLs,
// which would be bundled into the app. We define chains ourselves with an empty
// rpcUrls list, because the transport is always the wallet -- viem never dials
// out on its own.

import { defineChain } from 'viem'
import type { Chain } from 'viem'
import { CHAINS } from '../chains/config.ts'

const chainCache = new Map<string, Chain>()

/**
 * Builds a viem Chain.
 *
 * `chainId` is what the wallet reports; `configChainId` is where the contract
 * addresses come from. They differ on a local fork, which serves mainnet's
 * contracts while reporting anvil's own id -- we need the reported id so
 * transactions validate, and the forked chain's Multicall3 so batching still
 * works.
 */
export function viemChain(chainId: number, configChainId = chainId): Chain | undefined {
	const key = `${chainId}:${configChainId}`
	const cached = chainCache.get(key)
	if (cached !== undefined) return cached

	const config = CHAINS[configChainId]
	if (config === undefined) return undefined

	const chain = defineChain({
		id: chainId,
		name: chainId === config.chainId ? config.name : `${config.name} (fork)`,
		nativeCurrency: { name: 'Ether', symbol: config.nativeSymbol, decimals: 18 },
		// Empty on purpose. The wallet provides transport; we never hold an endpoint.
		rpcUrls: { default: { http: [] } },
		contracts: { multicall3: { address: config.contracts.multicall3 } },
	})
	chainCache.set(key, chain)
	return chain
}

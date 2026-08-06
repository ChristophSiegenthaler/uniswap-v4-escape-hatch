// Probes what the connected wallet's RPC can actually do.
//
// Wallet-injected RPCs vary enormously. Some are full archive nodes; some are a
// rate-limited free tier that refuses eth_getLogs outright. Rather than assume,
// we probe once per connection and let features degrade honestly.
//
// Nothing here is load-bearing for the emergency exit. That path deliberately
// uses only eth_call, so it keeps working on the most restricted RPC we might
// meet. These probes exist to decide whether to *offer* the convenience paths.

import { signal } from '@preact/signals'
import type { Address } from 'viem'
import { CHAINS, MULTICALL3 } from '../chains/config.ts'
import type { EIP1193Provider } from './eip6963.ts'

export interface Capabilities {
	/** Multicall3 is deployed here, so reads can be batched into one round trip. */
	multicall: boolean
	/**
	 * eth_getLogs works over a usable range. Enables convenience discovery of the
	 * user's LP positions by scanning Transfer events. Never required.
	 */
	logs: boolean
	/**
	 * The endpoint answered an anvil/hardhat admin method.
	 *
	 * A positive is conclusive; a negative proves nothing. MetaMask and other
	 * wallets filter unrecognised RPC namespaces, so a genuine local node very
	 * often reports false here. Never gate behaviour on it -- use forkedChainId,
	 * which relies only on eth_getCode.
	 *
	 * Worth detecting loudly. A forked node normally claims the chain id it forked
	 * from, so a mainnet fork is indistinguishable from mainnet by chain id alone --
	 * the app cannot tell, and neither can the user. That is dangerous in both
	 * directions: mistaking mainnet for a fork risks signing something real, and
	 * mistaking a fork for mainnet makes correct behaviour look broken.
	 */
	localNode: boolean
	/**
	 * When on a local node whose chain id we do not recognise, the chain it appears
	 * to have forked -- worked out by asking which PoolManager has bytecode.
	 *
	 * A fork keeps every contract at its original address but usually reports
	 * anvil's own chain id (31337), because wallets refuse to add a second network
	 * claiming an id they already know. So the chain id tells us nothing and the
	 * deployed code tells us everything.
	 */
	forkedChainId?: number
	/** Probing finished. */
	probed: boolean
}

export const capabilities = signal<Capabilities>({
	multicall: false, logs: false, localNode: false, probed: false,
})

async function probeMulticall(provider: EIP1193Provider): Promise<boolean> {
	try {
		const code = await provider.request({
			method: 'eth_getCode',
			params: [MULTICALL3 as Address, 'latest'],
		})
		return typeof code === 'string' && code.length > 4
	} catch {
		return false
	}
}

async function probeLogs(provider: EIP1193Provider): Promise<boolean> {
	try {
		const head = await provider.request({ method: 'eth_blockNumber' })
		if (typeof head !== 'string') return false
		const to = BigInt(head)
		// A single-block window with a topic that matches almost nothing: cheap for
		// an honest node, and still rejected outright by RPCs that disallow getLogs.
		await provider.request({
			method: 'eth_getLogs',
			params: [{
				fromBlock: `0x${to.toString(16)}`,
				toBlock: `0x${to.toString(16)}`,
				topics: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
			}],
		})
		return true
	} catch {
		return false
	}
}

/**
 * Detects anvil/hardhat. Both expose namespaced admin methods that no public
 * endpoint implements, so a successful call is a reliable tell.
 */
async function probeLocalNode(provider: EIP1193Provider): Promise<boolean> {
	for (const method of ['anvil_nodeInfo', 'hardhat_metadata']) {
		try {
			const result = await provider.request({ method })
			if (result !== null && result !== undefined) return true
		} catch {
			// Expected against a real node: the method does not exist.
		}
	}
	return false
}

/**
 * Works out which chain a local fork is standing in for.
 *
 * Each supported chain has a PoolManager at a distinct address, so whichever one
 * holds bytecode identifies the forked chain. Returns undefined if none match,
 * which means a fork of something we have no addresses for.
 */
async function detectForkedChain(provider: EIP1193Provider): Promise<number | undefined> {
	for (const chain of Object.values(CHAINS)) {
		try {
			const code = await provider.request({
				method: 'eth_getCode',
				params: [chain.contracts.poolManager, 'latest'],
			})
			if (typeof code !== 'string') continue
			// Presence of code is not enough: an unrelated contract could occupy that
			// address on a chain we do not support, and misidentifying the chain would
			// point every subsequent call at the wrong addresses. Require the exact
			// runtime size of the PoolManager we pinned and verified.
			const size = code.length / 2 - 1
			if (size === chain.poolManagerCodeSize) return chain.chainId
		} catch {
			// Try the next candidate.
		}
	}
	return undefined
}

export async function probeCapabilities(
	provider: EIP1193Provider,
	chainId: number,
): Promise<void> {
	const [multicall, logs, localNode] = await Promise.all([
		probeMulticall(provider), probeLogs(provider), probeLocalNode(provider),
	])

	// Detect purely on the chain id being unknown -- NOT on having proved it is a
	// local node. Wallets restrict which RPC methods they forward, and MetaMask
	// rejects anvil_*/hardhat_* before they ever reach the node, so `localNode` is
	// false for most real users running a fork. Gating detection on it made the
	// feature fail in exactly the case it exists for.
	const forkedChainId = CHAINS[chainId] === undefined
		? await detectForkedChain(provider)
		: undefined

	capabilities.value = {
		multicall, logs, localNode, probed: true,
		...(forkedChainId !== undefined && { forkedChainId }),
	}
}

export function resetCapabilities(): void {
	capabilities.value = { multicall: false, logs: false, localNode: false, probed: false }
}

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
import { MULTICALL3 } from '../chains/config.ts'
import type { EIP1193Provider } from './eip6963.ts'

export interface Capabilities {
	/** Multicall3 is deployed here, so reads can be batched into one round trip. */
	multicall: boolean
	/**
	 * eth_getLogs works over a usable range. Enables convenience discovery of the
	 * user's LP positions by scanning Transfer events. Never required.
	 */
	logs: boolean
	/** Probing finished. */
	probed: boolean
}

export const capabilities = signal<Capabilities>({ multicall: false, logs: false, probed: false })

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

export async function probeCapabilities(provider: EIP1193Provider): Promise<void> {
	const [multicall, logs] = await Promise.all([probeMulticall(provider), probeLogs(provider)])
	capabilities.value = { multicall, logs, probed: true }
}

export function resetCapabilities(): void {
	capabilities.value = { multicall: false, logs: false, probed: false }
}

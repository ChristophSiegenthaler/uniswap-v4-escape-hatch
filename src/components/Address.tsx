// Address display: checksummed, truncated, copyable, linked to an explorer, and
// ENS-resolved where that is actually possible.
//
// ENS resolves on mainnet only. Reverse records live on L1, so a user connected
// to Base or Arbitrum would need a mainnet endpoint to read them -- and the only
// endpoint we have is their wallet, pointed at the chain they are on. Cross-chain
// ENS via CCIP-read needs a gateway server, the exact dependency this project
// refuses. Elsewhere a checksummed address is the honest answer.

import { useEffect, useState } from 'preact/hooks'
import { getAddress } from 'viem'
import type { Address as AddressType } from 'viem'
import { activeChainConfig, chainId, getPublicClient } from '../wallet/provider.ts'
import { ensNameFor, resolveEnsName } from '../wallet/ens.ts'

function truncate(address: string): string {
	return `${address.slice(0, 6)}...${address.slice(-4)}`
}

interface AddressProps {
	address: AddressType
	/** Show the whole address rather than a truncation. */
	full?: boolean
}

export function Address({ address, full = false }: AddressProps) {
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		const client = getPublicClient()
		if (client === undefined || chainId.value === undefined) return
		void resolveEnsName(client, chainId.value, address)
	}, [address, chainId.value])

	// Checksum before display: mixed-case is the only in-band typo protection an
	// Ethereum address has.
	let checksummed: string
	try {
		checksummed = getAddress(address)
	} catch {
		return <span class='addr' title='Not a valid address'>{String(address)}</span>
	}

	const explorer = activeChainConfig.value?.explorer
	const ensName = ensNameFor(address)
	// Prefer a verified ENS name, but keep the address in the tooltip: the name is
	// a convenience, the address is the thing that actually receives funds.
	const shown = ensName ?? (full ? checksummed : truncate(checksummed))

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(checksummed)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard blocked (insecure context); the address is selectable anyway.
		}
	}

	return (
		<span class='addr'>
			<span title={checksummed}>{shown}</span>
			<button class='icon-btn' onClick={() => void copy()} title='Copy address'>
				{copied ? 'copied' : 'copy'}
			</button>
			{explorer !== undefined && (
				<a
					href={`${explorer}/address/${checksummed}`}
					target='_blank'
					rel='noopener noreferrer'
					title='View on block explorer'
				>explorer</a>
			)}
		</span>
	)
}

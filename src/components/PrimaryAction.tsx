// Resolves the four-state action flow into exactly one visible button.
//
//   1. no wallet connected  -> Connect wallet
//   2. wrong / unknown chain -> Switch to <chain>
//   3. needs an approval     -> Approve (supplied by the caller)
//   4. ready                 -> the real action
//
// Network state is checked BEFORE approval state, because an approval read taken
// on the wrong chain is meaningless -- the allowance being inspected belongs to a
// different deployment. Only one of these ever renders, which is what stops users
// clicking a main action while still on the wrong network.

import type { ComponentChildren } from 'preact'
import { account, chainId, isSupportedChain, switchChain } from '../wallet/provider.ts'
import { getChain, SUPPORTED_CHAIN_IDS } from '../chains/config.ts'
import { TxButton } from './TxButton.tsx'

interface PrimaryActionProps {
	/** Chain the action must run on. Defaults to whatever is connected, if supported. */
	requiredChainId?: number
	onConnect: () => void
	/** No wallet is installed, so there is genuinely nothing to connect to. */
	connectDisabled?: boolean
	/** The approve step, if the action currently needs one. */
	approval?: ComponentChildren
	/** The action itself, shown once connected, on-chain and approved. */
	children: ComponentChildren
}

export function PrimaryAction({ requiredChainId, onConnect, connectDisabled = false, approval, children }: PrimaryActionProps) {
	if (account.value === undefined) {
		// A button, never a paragraph telling the user to go and connect. It is
		// disabled only when no wallet exists at all -- a button that does nothing
		// when pressed is worse than the paragraph this rule exists to prevent.
		return (
			<button class='btn-primary' onClick={onConnect} disabled={connectDisabled}>
				{connectDisabled ? 'No wallet detected' : 'Connect wallet'}
			</button>
		)
	}

	if (!isSupportedChain.value) {
		const fallback = SUPPORTED_CHAIN_IDS[0]
		const target = requiredChainId ?? fallback
		const name = target === undefined ? 'a supported network' : getChain(target)?.name ?? 'a supported network'
		return (
			<TxButton
				label={`Switch to ${name}`}
				pendingLabel='Switching...'
				cooldownMs={0}
				onClick={async () => { if (target !== undefined) await switchChain(target) }}
			/>
		)
	}

	if (requiredChainId !== undefined && chainId.value !== requiredChainId) {
		const name = getChain(requiredChainId)?.name ?? 'the right network'
		return (
			<TxButton
				label={`Switch to ${name}`}
				pendingLabel='Switching...'
				cooldownMs={0}
				onClick={() => switchChain(requiredChainId)}
			/>
		)
	}

	if (approval !== undefined && approval !== false && approval !== null) return <>{approval}</>

	return <>{children}</>
}

// EIP-6963 multi-injected provider discovery.
//
// We use EIP-6963 rather than a curated connector list (RainbowKit-style). It
// discovers every injected wallet the user actually has -- MetaMask, Rabby,
// Frame, Phantom, Brave and anything else -- without us maintaining an allowlist,
// and without WalletConnect, whose relay would be exactly the kind of third-party
// server this project exists to avoid.

import { signal } from '@preact/signals'

export interface EIP1193Provider {
	request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>
	on?(event: string, listener: (...args: never[]) => void): void
	removeListener?(event: string, listener: (...args: never[]) => void): void
}

export interface EIP6963ProviderInfo {
	uuid: string
	name: string
	icon: string
	rdns: string
}

export interface DiscoveredProvider {
	info: EIP6963ProviderInfo
	provider: EIP1193Provider
}

export const discoveredProviders = signal<readonly DiscoveredProvider[]>([])

/**
 * Wallet icons are data: URIs per EIP-6963. A wallet announcing a remote URL
 * would make the page fetch from a third party the moment we rendered it, which
 * would quietly break the guarantee that the wallet is our only network peer.
 * Anything that is not a data: URI is dropped and rendered as a text fallback.
 */
function safeIcon(icon: unknown): string {
	return typeof icon === 'string' && icon.startsWith('data:') ? icon : ''
}

function isProviderDetail(detail: unknown): detail is DiscoveredProvider {
	if (detail === null || typeof detail !== 'object') return false
	const candidate = detail as { info?: unknown; provider?: unknown }
	if (candidate.info === null || typeof candidate.info !== 'object') return false
	if (candidate.provider === null || typeof candidate.provider !== 'object') return false
	const info = candidate.info as { uuid?: unknown; rdns?: unknown; name?: unknown }
	return typeof info.uuid === 'string' && typeof info.rdns === 'string' && typeof info.name === 'string'
}

let started = false

/** Begins listening for wallet announcements. Safe to call more than once. */
export function startProviderDiscovery(): void {
	if (started || typeof window === 'undefined') return
	started = true

	window.addEventListener('eip6963:announceProvider', (event: Event) => {
		const detail = (event as CustomEvent).detail
		if (!isProviderDetail(detail)) return
		// Wallets re-announce on request; keep the list unique by rdns.
		if (discoveredProviders.value.some(p => p.info.rdns === detail.info.rdns)) return
		discoveredProviders.value = [...discoveredProviders.value, {
			info: { ...detail.info, icon: safeIcon(detail.info.icon) },
			provider: detail.provider,
		}]
	})

	window.dispatchEvent(new Event('eip6963:requestProvider'))

	// Legacy fallback: a wallet that predates EIP-6963 only exposes window.ethereum
	// and will never announce itself.
	setTimeout(() => {
		if (discoveredProviders.value.length > 0) return
		const legacy = (window as { ethereum?: EIP1193Provider }).ethereum
		if (legacy === undefined) return
		discoveredProviders.value = [{
			info: { uuid: 'legacy', name: 'Injected wallet', icon: '', rdns: 'legacy.injected' },
			provider: legacy,
		}]
	}, 500)
}

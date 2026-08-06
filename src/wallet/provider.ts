// Wallet connection state and viem clients.
//
// The wallet's EIP-1193 provider is the ONLY transport. There is no fallback
// http() transport anywhere in this file, and there must never be one: a
// fallback would mean that when the wallet is unavailable the app quietly starts
// talking to somebody else's server. If there is no wallet, the app says so.

import { computed, signal } from '@preact/signals'
import { createPublicClient, createWalletClient, custom, getAddress } from 'viem'
import type { Address, PublicClient, WalletClient } from 'viem'
import { getChain } from '../chains/config.ts'
import { viemChain } from './chains.ts'
import type { DiscoveredProvider, EIP1193Provider } from './eip6963.ts'
import { toFriendlyError } from './errors.ts'

export const activeProvider = signal<DiscoveredProvider | undefined>(undefined)
export const account = signal<Address | undefined>(undefined)
export const chainId = signal<number | undefined>(undefined)
export const connecting = signal(false)
export const connectionError = signal<string | undefined>(undefined)
export const blockNumber = signal<bigint | undefined>(undefined)

export const isConnected = computed(() => account.value !== undefined)

/** True when connected to a chain we have v4 addresses for. */
export const isSupportedChain = computed(() =>
	chainId.value !== undefined && getChain(chainId.value) !== undefined)

export const activeChainConfig = computed(() =>
	chainId.value === undefined ? undefined : getChain(chainId.value))

let publicClient: PublicClient | undefined
let walletClient: WalletClient | undefined

export function getPublicClient(): PublicClient | undefined { return publicClient }
export function getWalletClient(): WalletClient | undefined { return walletClient }

function rebuildClients(): void {
	const provider = activeProvider.value
	const id = chainId.value
	if (provider === undefined || id === undefined) {
		publicClient = undefined
		walletClient = undefined
		return
	}
	const chain = viemChain(id)
	const transport = custom(provider.provider)
	// A wallet RPC is a shared, rate-limited resource. frontend-ux Rule 5 asks for
	// 2-5s responsiveness; we poll block numbers at 5s and recompute derived state
	// on new blocks rather than re-polling every value on a timer.
	publicClient = createPublicClient({
		...(chain !== undefined && { chain }),
		transport,
		pollingInterval: 5_000,
		// CCIP-read (EIP-3668) is ON by default in viem, and it is a genuine hole in
		// the zero-server promise: when a contract reverts with OffchainLookup, viem
		// obediently fetches a URL *the contract chose*. That would leak the user's
		// IP and the address they are querying to an arbitrary third-party gateway,
		// triggered by chain data rather than by anything in this codebase.
		// Off, permanently.
		ccipRead: false,
	})
	walletClient = createWalletClient({ ...(chain !== undefined && { chain }), transport })
}

async function readChainId(provider: EIP1193Provider): Promise<number> {
	const raw = await provider.request({ method: 'eth_chainId' })
	return typeof raw === 'string' ? parseInt(raw, 16) : Number(raw)
}

function handleAccountsChanged(accounts: unknown): void {
	const list = Array.isArray(accounts) ? accounts as string[] : []
	const first = list[0]
	// Empty array means the user disconnected this site from inside the wallet.
	account.value = first === undefined ? undefined : getAddress(first)
	if (account.value === undefined) disconnect()
}

function handleChainChanged(raw: unknown): void {
	chainId.value = typeof raw === 'string' ? parseInt(raw, 16) : Number(raw)
	rebuildClients()
}

let detach: (() => void) | undefined

export async function connect(discovered: DiscoveredProvider): Promise<void> {
	connecting.value = true
	connectionError.value = undefined
	try {
		const provider = discovered.provider
		const accounts = await provider.request({ method: 'eth_requestAccounts' })
		const list = Array.isArray(accounts) ? accounts as string[] : []
		const first = list[0]
		if (first === undefined) throw new Error('Wallet returned no accounts.')

		activeProvider.value = discovered
		// Checksum immediately: a mis-cased address compared as a raw string will
		// silently fail equality checks later.
		account.value = getAddress(first)
		chainId.value = await readChainId(provider)
		rebuildClients()

		provider.on?.('accountsChanged', handleAccountsChanged as (...args: never[]) => void)
		provider.on?.('chainChanged', handleChainChanged as (...args: never[]) => void)
		detach = () => {
			provider.removeListener?.('accountsChanged', handleAccountsChanged as (...args: never[]) => void)
			provider.removeListener?.('chainChanged', handleChainChanged as (...args: never[]) => void)
		}

		rememberWallet(discovered.info.rdns)
		startBlockWatcher()
	} catch (error) {
		const friendly = toFriendlyError(error)
		// Staying silent on a deliberate rejection: it is not an error condition.
		connectionError.value = friendly.userRejected ? undefined : friendly.message
	} finally {
		connecting.value = false
	}
}

export function disconnect(): void {
	stopBlockWatcher()
	detach?.()
	detach = undefined
	activeProvider.value = undefined
	account.value = undefined
	chainId.value = undefined
	blockNumber.value = undefined
	publicClient = undefined
	walletClient = undefined
	forgetWallet()
}

/**
 * Asks the wallet to switch chains.
 *
 * Note we never attempt wallet_addEthereumChain: adding a chain requires handing
 * the wallet an RPC URL, and we do not ship any. If the user's wallet does not
 * know the chain, they add it themselves -- with an endpoint they chose.
 */
export async function switchChain(targetChainId: number): Promise<void> {
	const provider = activeProvider.value?.provider
	if (provider === undefined) return
	connectionError.value = undefined
	try {
		await provider.request({
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: `0x${targetChainId.toString(16)}` }],
		})
	} catch (error) {
		const friendly = toFriendlyError(error)
		if (friendly.userRejected) return
		const code = (error as { code?: number }).code
		connectionError.value = code === 4902
			? `Your wallet does not have ${getChain(targetChainId)?.name ?? 'that network'} configured. Add it in your wallet, then retry.`
			: friendly.message
	}
}

// --- block watcher -----------------------------------------------------------
// One cheap poll drives all downstream refreshes, instead of every component
// polling its own values. Keeps request volume flat and predictable, which is
// what a wallet RPC needs.

let blockTimer: ReturnType<typeof setInterval> | undefined

function startBlockWatcher(): void {
	stopBlockWatcher()
	const poll = async () => {
		const client = publicClient
		if (client === undefined) return
		try {
			blockNumber.value = await client.getBlockNumber({ cacheTime: 0 })
		} catch {
			// A dropped poll is not worth surfacing; the next tick retries.
		}
	}
	void poll()
	blockTimer = setInterval(() => void poll(), 5_000)
}

function stopBlockWatcher(): void {
	if (blockTimer !== undefined) clearInterval(blockTimer)
	blockTimer = undefined
}

// --- reconnect ---------------------------------------------------------------

const STORAGE_KEY = 'uniswap-v4-escape-hatch:wallet-rdns'

function rememberWallet(rdns: string): void {
	try { localStorage.setItem(STORAGE_KEY, rdns) } catch { /* private mode */ }
}

function forgetWallet(): void {
	try { localStorage.removeItem(STORAGE_KEY) } catch { /* private mode */ }
}

/**
 * Reconnects to the previously used wallet without prompting, but only if it is
 * already authorised -- eth_accounts does not raise a popup, eth_requestAccounts
 * would.
 */
export async function tryReconnect(available: readonly DiscoveredProvider[]): Promise<void> {
	let remembered: string | null = null
	try { remembered = localStorage.getItem(STORAGE_KEY) } catch { return }
	if (remembered === null) return

	const match = available.find(p => p.info.rdns === remembered)
	if (match === undefined) return

	try {
		const accounts = await match.provider.request({ method: 'eth_accounts' })
		const list = Array.isArray(accounts) ? accounts as string[] : []
		if (list[0] === undefined) return
		await connect(match)
	} catch {
		// Wallet locked or unavailable; the user can connect manually.
	}
}

import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { discoveredProviders, startProviderDiscovery } from './wallet/eip6963.ts'
import {
	account, activeChainConfig, activeProvider, blockNumber, chainId,
	connect, connectionError, isSupportedChain, tryReconnect,
} from './wallet/provider.ts'
import { capabilities, probeCapabilities, resetCapabilities } from './wallet/capabilities.ts'
import { SUPPORTED_CHAIN_IDS, getChain } from './chains/config.ts'
import { WalletPicker } from './components/ConnectButton.tsx'
import { PrimaryAction } from './components/PrimaryAction.tsx'
import { TxButton } from './components/TxButton.tsx'
import { Pools } from './components/Pools.tsx'
import { Positions } from './components/Positions.tsx'
import './styles.css'

function Capability({ on, label, note }: { on: boolean; label: string; note: string }) {
	return (
		<div class='row'>
			<span class='label'>{label}<br /><span class='muted'>{note}</span></span>
			<span class={`pill ${on ? 'pill-ok' : 'pill-off'}`}>{on ? 'available' : 'unavailable'}</span>
		</div>
	)
}

function ChainStatus() {
	const config = activeChainConfig.value
	if (chainId.value === undefined) return null

	if (!isSupportedChain.value) {
		const names = SUPPORTED_CHAIN_IDS.map(id => getChain(id)?.name).filter(Boolean).join(', ')
		return (
			<div class='alert alert-warn'>
				Connected to chain {chainId.value}, which has no Uniswap v4 deployment in our
				pinned config. Supported: {names}.
			</div>
		)
	}

	return (
		<div class='card'>
			<h2>Network</h2>
			<div class='row'>
				<span class='label'>Chain</span>
				<span class='value'>{config?.name} ({chainId.value})</span>
			</div>
			<div class='row'>
				<span class='label'>Block</span>
				<span class='value'>{blockNumber.value?.toString() ?? '—'}</span>
			</div>
			<div class='row'>
				<span class='label'>PoolManager</span>
				<span class='value'>{config?.contracts.poolManager.slice(0, 10)}…</span>
			</div>
		</div>
	)
}

function App() {
	useEffect(() => {
		startProviderDiscovery()
	}, [])

	// Reconnect silently once wallets have announced themselves.
	useEffect(() => {
		if (discoveredProviders.value.length === 0) return
		if (account.value !== undefined) return
		void tryReconnect(discoveredProviders.value)
	}, [discoveredProviders.value.length])

	// Probe the RPC each time the wallet or chain changes -- capabilities are a
	// property of the endpoint, and switching networks can switch endpoints.
	useEffect(() => {
		const provider = activeProvider.value?.provider
		if (provider === undefined || chainId.value === undefined) {
			resetCapabilities()
			return
		}
		void probeCapabilities(provider)
	}, [activeProvider.value, chainId.value])

	const caps = capabilities.value
	const providers = discoveredProviders.value

	// With a single wallet there is no choice to make, so connect straight away.
	// With several, send the user to the picker rather than guessing for them.
	const handleConnect = () => {
		const only = providers.length === 1 ? providers[0] : undefined
		if (only !== undefined) { void connect(only); return }
		document.getElementById('wallet-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
	}

	return (
		<div class='app'>
			<header>
				<h1>Uniswap v4 Escape Hatch</h1>
				<p class='tagline'>
					A Uniswap v4 interface that talks only to your wallet. No backend, no
					indexer, no third-party RPC.
				</p>
			</header>

			{capabilities.value.localNode && (
				<div class='alert alert-warn' role='status'>
					<strong>Local development node.</strong> You are connected to anvil or
					hardhat, not to {activeChainConfig.value?.name ?? 'a real network'} — even
					though it reports the same chain id. Balances, ownership and prices here
					are a local copy. Nothing you sign leaves this machine.
				</div>
			)}

			{connectionError.value !== undefined && (
				<div class='alert alert-error'>{connectionError.value}</div>
			)}

			<div class='card' id='wallet-card'>
				<h2>Wallet</h2>
				<WalletPicker />
			</div>

			<ChainStatus />

			{account.value !== undefined && caps.probed && (
				<div class='card'>
					<h2>Your RPC's capabilities</h2>
					<Capability
						on={caps.multicall}
						label='Batched reads'
						note='Multicall3 — folds many reads into one request'
					/>
					<Capability
						on={caps.logs}
						label='Event history'
						note='eth_getLogs — optional convenience for finding your LP positions'
					/>
					{!caps.logs && (
						<p class='muted' style='margin:0.75rem 0 0'>
							Your RPC will not serve logs. That is fine: exiting a position needs
							only its token ID, and never depends on event history.
						</p>
					)}
				</div>
			)}

			{account.value !== undefined && isSupportedChain.value && <Positions />}

			{account.value !== undefined && isSupportedChain.value && <Pools />}

			<div class='card'>
				<h2>Action flow</h2>
				<p class='muted' style='margin:0 0 0.75rem'>
					One button at a time, resolving connect → network → approve → act.
				</p>
				<PrimaryAction onConnect={handleConnect} connectDisabled={providers.length === 0}>
					<TxButton
						label='Ready'
						pendingLabel='Working...'
						onClick={async () => { await new Promise(r => setTimeout(r, 800)) }}
					/>
				</PrimaryAction>
				{providers.length === 0 && (
					<p class='muted' style='margin:0.6rem 0 0'>
						Nothing to connect to until a wallet is installed.
					</p>
				)}
			</div>
		</div>
	)
}

const root = document.getElementById('app')
if (root !== null) render(<App />, root)

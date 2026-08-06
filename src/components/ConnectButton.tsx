import { discoveredProviders } from '../wallet/eip6963.ts'
import { account, connect, connecting, disconnect } from '../wallet/provider.ts'
import { Address } from './Address.tsx'

export function WalletPicker() {
	const providers = discoveredProviders.value

	if (account.value !== undefined) {
		return (
			<div class='row'>
				<Address address={account.value} />
				<button onClick={disconnect}>Disconnect</button>
			</div>
		)
	}

	if (providers.length === 0) {
		return (
			<div class='stack'>
				<p class='muted' style='margin:0'>
					No browser wallet detected. This app talks only to your wallet's RPC, so
					it needs one installed to read anything at all.
				</p>
			</div>
		)
	}

	return (
		<div class='wallet-list'>
			{providers.map(p => (
				<button
					key={p.info.rdns}
					class='wallet-option'
					disabled={connecting.value}
					onClick={() => void connect(p)}
				>
					{p.info.icon !== ''
						? <img src={p.info.icon} alt='' />
						: <span class='wallet-badge' aria-hidden='true'>{p.info.name.slice(0, 1)}</span>}
					<span>{p.info.name}</span>
					{connecting.value && <span class='spinner' aria-hidden='true' />}
				</button>
			))}
		</div>
	)
}

// Pool discovery panel: enter two currencies, see which v4 pools actually exist.
//
// This is the read layer made visible. It also makes the honest limits of
// discovery visible: what you get back is the set of deep hookless pools we know
// how to guess, not an index of every pool on the chain.

import { useState } from 'preact/hooks'
import { formatUnits, isAddress } from 'viem'
import type { Address } from 'viem'
import { NATIVE_CURRENCY } from '../chains/config.ts'
import { activeChainConfig, chainId, getPublicClient } from '../wallet/provider.ts'
import { capabilities } from '../wallet/capabilities.ts'
import { discoverPools } from '../v4/discover.ts'
import type { PoolState } from '../v4/discover.ts'
import { fetchTokenMetadata, parseTokenAddress } from '../tokens/metadata.ts'
import type { TokenMetadata } from '../tokens/metadata.ts'
import { toFriendlyError } from '../wallet/errors.ts'

/** Fee in hundredths of a bip, shown as a percentage. */
function formatFee(fee: number): string {
	return `${(fee / 10_000).toFixed(fee % 10_000 === 0 ? 2 : 4)}%`
}

export function Pools() {
	const chain = activeChainConfig.value
	const [tokenA, setTokenA] = useState<string>(NATIVE_CURRENCY)
	const [tokenB, setTokenB] = useState<string>(chain?.baseTokens[1]?.address ?? '')
	const [pools, setPools] = useState<PoolState[] | undefined>(undefined)
	const [tokens, setTokens] = useState<Map<string, TokenMetadata>>(new Map())
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	const validA = tokenA === NATIVE_CURRENCY || isAddress(tokenA)
	const validB = tokenB === NATIVE_CURRENCY || isAddress(tokenB)

	const search = async () => {
		const client = getPublicClient()
		const id = chainId.value
		if (client === undefined || id === undefined) return

		const a = tokenA === NATIVE_CURRENCY ? NATIVE_CURRENCY : parseTokenAddress(tokenA)
		const b = tokenB === NATIVE_CURRENCY ? NATIVE_CURRENCY : parseTokenAddress(tokenB)
		if (a === undefined || b === undefined) { setError('Enter two valid addresses.'); return }

		setBusy(true)
		setError(undefined)
		try {
			const useMulticall = capabilities.value.multicall
			const [found, metadata] = await Promise.all([
				discoverPools(client, id, a as Address, b as Address, useMulticall),
				fetchTokenMetadata(client, id, [a as Address, b as Address], useMulticall),
			])
			setPools(found)
			setTokens(metadata)
		} catch (err) {
			setError(toFriendlyError(err).message)
			setPools(undefined)
		} finally {
			setBusy(false)
		}
	}

	const symbolFor = (address: Address) =>
		tokens.get(address.toLowerCase())?.symbol ?? `${address.slice(0, 6)}…`

	return (
		<div class='card'>
			<h2>Pool discovery</h2>

			<div class='stack'>
				<label class='muted'>
					Currency A
					<input
						class='input'
						value={tokenA}
						onInput={e => setTokenA((e.target as HTMLInputElement).value)}
						placeholder='0x… or zero address for native ETH'
						spellcheck={false}
					/>
				</label>
				<label class='muted'>
					Currency B
					<input
						class='input'
						value={tokenB}
						onInput={e => setTokenB((e.target as HTMLInputElement).value)}
						placeholder='0x…'
						spellcheck={false}
					/>
				</label>

				{chain !== undefined && (
					<div class='chips'>
						<button class='chip' onClick={() => setTokenA(NATIVE_CURRENCY)}>A = {chain.nativeSymbol}</button>
						{chain.baseTokens.map(token => (
							<button key={token.address} class='chip' onClick={() => setTokenB(token.address)}>
								B = {token.symbol}
							</button>
						))}
					</div>
				)}

				<button
					class='btn-primary'
					disabled={busy || !validA || !validB}
					onClick={() => void search()}
				>
					{busy && <span class='spinner' aria-hidden='true' />}
					{busy ? 'Searching…' : 'Find pools'}
				</button>
			</div>

			{error !== undefined && <div class='alert alert-error' style='margin-top:0.75rem'>{error}</div>}

			{pools !== undefined && pools.length === 0 && (
				<p class='muted' style='margin:0.9rem 0 0'>
					No hookless pool found at the conventional fee tiers. That does not mean
					none exists — v4 lets a pool pick any fee and tick spacing, and hook pools
					cannot be enumerated at all. Enter a full PoolKey to reach those.
				</p>
			)}

			{pools !== undefined && pools.length > 0 && (
				<div style='margin-top:0.9rem'>
					<div class='row'>
						<span class='label'>
							{symbolFor(pools[0]!.poolKey.currency0)} / {symbolFor(pools[0]!.poolKey.currency1)}
						</span>
						<span class='label'>{pools.length} pool(s)</span>
					</div>
					{pools.map(pool => (
						<div class='row' key={pool.poolId}>
							<span class='value'>
								{formatFee(pool.poolKey.fee)}
								<span class='muted'> · spacing {pool.poolKey.tickSpacing} · tick {pool.tick}</span>
							</span>
							<span class='value' title={`${pool.liquidity} liquidity units`}>
								{pool.liquidity === 0n
									? <span class='muted'>no liquidity</span>
									: `L ${Number(formatUnits(pool.liquidity, 12)).toFixed(2)}e12`}
							</span>
						</div>
					))}
					<p class='muted' style='margin:0.75rem 0 0'>
						Liquidity is the pool's active virtual liquidity, not a token amount.
						Converting it to real balances needs tick maths, which lands in M3.
					</p>
				</div>
			)}
		</div>
	)
}

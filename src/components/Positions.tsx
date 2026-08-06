// Emergency LP exit.
//
// Designed for someone using it under pressure, possibly for the first time,
// possibly because the official interface is gone. So: one input, a plain summary
// of what will happen, and one button. Nothing here requires discovery, an
// indexer, or event history — a token id is enough.

import { useCallback, useEffect, useState } from 'preact/hooks'
import { formatUnits } from 'viem'
import type { Address } from 'viem'
import { NATIVE_CURRENCY } from '../chains/config.ts'
import { account, activeChainConfig, chainId, effectiveChainId, getPublicClient, getWalletClient } from '../wallet/provider.ts'
import { capabilities } from '../wallet/capabilities.ts'
import { viemChain } from '../wallet/chains.ts'
import { toFriendlyError } from '../wallet/errors.ts'
import { fetchTokenMetadata } from '../tokens/metadata.ts'
import type { TokenMetadata } from '../tokens/metadata.ts'
import {
	buildExitTransaction, computeExitMinimums, estimatePositionValue,
	forgetTokenId, loadRememberedTokenIds, readPosition, rememberTokenId,
} from '../v4/positions.ts'
import type { Position, PositionLookup } from '../v4/positions.ts'
import type { TokenAmounts } from '../v4/math/liquidityAmounts.ts'
import { Address as AddressView } from './Address.tsx'
import { TxButton } from './TxButton.tsx'

const DEFAULT_SLIPPAGE_BPS = 100 // 1%

function formatAmount(amount: bigint, token: TokenMetadata | undefined): string {
	if (token === undefined) return `${amount} (raw)`
	const formatted = formatUnits(amount, token.decimals)
	const numeric = Number(formatted)
	const shown = numeric === 0 ? '0' : numeric < 0.0001 ? formatted : numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })
	return `${shown} ${token.symbol}`
}

export function Positions() {
	const chain = activeChainConfig.value
	const [input, setInput] = useState('')
	const [lookup, setLookup] = useState<PositionLookup | undefined>(undefined)
	const [estimate, setEstimate] = useState<TokenAmounts | undefined>(undefined)
	const [tokens, setTokens] = useState<Map<string, TokenMetadata>>(new Map())
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)
	const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
	const [forceZeroMinimums, setForceZeroMinimums] = useState(false)
	const [remembered, setRemembered] = useState<bigint[]>([])
	const [done, setDone] = useState<string | undefined>(undefined)

	// Contract addresses come from the forked chain; the tx goes to the wallet's chain.
	const id = effectiveChainId.value

	useEffect(() => {
		if (id !== undefined) setRemembered(loadRememberedTokenIds(id))
	}, [id])

	const load = useCallback(async (tokenId: bigint) => {
		const client = getPublicClient()
		if (client === undefined || id === undefined) return
		setLoading(true)
		setError(undefined)
		setDone(undefined)
		setEstimate(undefined)
		try {
			const result = await readPosition(client, id, tokenId, capabilities.value.multicall)
			setLookup(result)

			if (result.status === 'found') {
				rememberTokenId(id, tokenId)
				setRemembered(loadRememberedTokenIds(id))
				const [value, metadata] = await Promise.all([
					estimatePositionValue(client, id, result.position),
					fetchTokenMetadata(client, id, [
						result.position.poolKey.currency0, result.position.poolKey.currency1,
					], capabilities.value.multicall),
				])
				setEstimate(value)
				setTokens(metadata)
			}
		} catch (err) {
			setError(toFriendlyError(err).message)
		} finally {
			setLoading(false)
		}
	}, [id])

	const submit = () => {
		const trimmed = input.trim()
		if (!/^\d+$/.test(trimmed)) { setError('A position id is a whole number, e.g. 365000.'); return }
		void load(BigInt(trimmed))
	}

	const position = lookup?.status === 'found' ? lookup.position : undefined
	const token0 = position === undefined ? undefined : tokens.get(position.poolKey.currency0.toLowerCase())
	const token1 = position === undefined ? undefined : tokens.get(position.poolKey.currency1.toLowerCase())

	const minimums = forceZeroMinimums
		? { amount0: 0n, amount1: 0n }
		: computeExitMinimums(estimate, slippageBps)

	const isOwner = position !== undefined && account.value !== undefined &&
		position.owner.toLowerCase() === account.value.toLowerCase()

	const exit = async () => {
		const walletClient = getWalletClient()
		if (walletClient === undefined || position === undefined || id === undefined || account.value === undefined) return

		const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800)
		const tx = buildExitTransaction(id, {
			position,
			recipient: account.value,
			amount0Min: minimums.amount0,
			amount1Min: minimums.amount1,
		}, deadline)
		if (tx === undefined) { setError('Could not build the exit transaction.'); return }

		setError(undefined)
		try {
			const hash = await walletClient.sendTransaction({
				account: account.value,
				to: tx.to,
				data: tx.data,
				value: tx.value,
				chain: viemChain(chainId.value ?? id, id),
			})
			setDone(hash)
			// Re-read so the UI reflects the closed position rather than stale state.
			await load(position.tokenId)
		} catch (err) {
			const friendly = toFriendlyError(err)
			if (!friendly.userRejected) setError(friendly.message)
		}
	}

	return (
		<div class='card'>
			<h2>Emergency exit</h2>
			<p class='muted' style='margin:0 0 0.75rem'>
				Withdraw a liquidity position using only its id. No indexer, no pool
				search — this works even for pools nothing can enumerate.
			</p>

			<div class='stack'>
				<label class='muted'>
					Position id
					<input
						class='input'
						value={input}
						inputMode='numeric'
						placeholder='e.g. 365000'
						spellcheck={false}
						onInput={e => setInput((e.target as HTMLInputElement).value)}
						onKeyDown={e => { if (e.key === 'Enter') submit() }}
					/>
				</label>
				<button class='btn-primary' disabled={loading || input.trim() === ''} onClick={submit}>
					{loading && <span class='spinner' aria-hidden='true' />}
					{loading ? 'Reading…' : 'Look up position'}
				</button>
			</div>

			{remembered.length > 0 && (
				<div style='margin-top:0.75rem'>
					<span class='label'>Previously viewed</span>
					<div class='chips' style='margin-top:0.35rem'>
						{remembered.map(tokenId => (
							<button key={String(tokenId)} class='chip' onClick={() => { setInput(String(tokenId)); void load(tokenId) }}>
								#{String(tokenId)}
							</button>
						))}
					</div>
				</div>
			)}

			<p class='muted' style='margin:0.75rem 0 0'>
				Your position id is the token id of the Uniswap NFT in your wallet. Any
				block explorer will show it — you do not need Uniswap's site to find it.
			</p>

			{error !== undefined && <div class='alert alert-error' style='margin-top:0.75rem'>{error}</div>}

			{done !== undefined && (
				<div class='alert' style='margin-top:0.75rem;border:1px solid var(--ok);color:var(--ok)'>
					Exit submitted. Transaction {done.slice(0, 10)}…
					{chain !== undefined && (
						<> · <a href={`${chain.explorer}/tx/${done}`} target='_blank' rel='noopener noreferrer'>view</a></>
					)}
				</div>
			)}

			{lookup?.status === 'empty' && (
				<div class='alert alert-warn' style='margin-top:0.75rem'>
					Position #{String(lookup.tokenId)} is already closed. Either it was burned,
					or it never existed. Nothing to withdraw.
				</div>
			)}

			{lookup?.status === 'error' && (
				<div class='alert alert-error' style='margin-top:0.75rem'>{lookup.message}</div>
			)}

			{position !== undefined && (
				<div style='margin-top:1rem'>
					{!position.keyVerified && (
						<div class='alert alert-error'>
							<strong>Do not sign anything.</strong> The pool details returned for this
							position do not match its stored pool id. That should be impossible
							against an honest node, so treat this endpoint as untrustworthy.
						</div>
					)}

					<div class='row'>
						<span class='label'>Pool</span>
						<span class='value'>
							{token0?.symbol ?? position.poolKey.currency0.slice(0, 8)} /{' '}
							{token1?.symbol ?? position.poolKey.currency1.slice(0, 8)}
						</span>
					</div>
					<div class='row'>
						<span class='label'>Fee tier</span>
						<span class='value'>{(position.poolKey.fee / 10_000).toFixed(4)}%</span>
					</div>
					<div class='row'>
						<span class='label'>Range</span>
						<span class='value'>{position.tickLower} … {position.tickUpper}</span>
					</div>
					<div class='row'>
						<span class='label'>Hook</span>
						<span class='value'>
							{position.poolKey.hooks.toLowerCase() === NATIVE_CURRENCY
								? 'none'
								: <AddressView address={position.poolKey.hooks} />}
						</span>
					</div>
					<div class='row'>
						<span class='label'>Owner</span>
						<span class='value'><AddressView address={position.owner} /></span>
					</div>
					<div class='row'>
						<span class='label'>Liquidity</span>
						<span class='value'>{String(position.liquidity)}</span>
					</div>

					{estimate !== undefined && (
						<div class='row'>
							<span class='label'>You should receive<br />
								<span class='muted'>principal only; fees are collected too</span>
							</span>
							<span class='value' style='text-align:right'>
								{formatAmount(estimate.amount0, token0)}<br />
								{formatAmount(estimate.amount1, token1)}
							</span>
						</div>
					)}

					{position.liquidity === 0n && (
						<div class='alert alert-warn' style='margin-top:0.75rem'>
							This position has no liquidity left. Burning it will still collect any
							unclaimed fees and destroy the NFT.
						</div>
					)}

					{!isOwner && (
						<div class='alert alert-warn' style='margin-top:0.75rem'>
							This position belongs to another address. You can inspect it, but only
							its owner can withdraw it.
						</div>
					)}

					<div class='stack' style='margin-top:1rem'>
						<label class='muted'>
							Slippage tolerance
							<select
								class='input'
								value={String(slippageBps)}
								disabled={forceZeroMinimums}
								onChange={e => setSlippageBps(Number((e.target as HTMLSelectElement).value))}
							>
								<option value='50'>0.5%</option>
								<option value='100'>1%</option>
								<option value='300'>3%</option>
								<option value='1000'>10%</option>
							</select>
						</label>

						<label class='muted' style='display:flex;gap:0.5rem;align-items:flex-start'>
							<input
								type='checkbox'
								checked={forceZeroMinimums}
								onChange={e => setForceZeroMinimums((e.target as HTMLInputElement).checked)}
							/>
							<span>
								<strong>Get me out regardless.</strong> Accept any amount, however
								small. This removes your price protection and lets a sandwicher take
								most of the value. Use it only if a normal exit keeps failing.
							</span>
						</label>

						{estimate === undefined && !forceZeroMinimums && (
							<div class='alert alert-warn' style='margin:0'>
								The pool's current price could not be read, so no minimum can be
								computed. This exit would be submitted without price protection.
							</div>
						)}

						<TxButton
							label={position.liquidity === 0n ? 'Burn position and collect fees' : 'Withdraw all liquidity'}
							pendingLabel='Confirm in your wallet…'
							disabled={!isOwner || !position.keyVerified}
							onClick={exit}
						/>
					</div>
				</div>
			)}
		</div>
	)
}

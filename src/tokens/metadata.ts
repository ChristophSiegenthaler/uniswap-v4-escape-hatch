// Token metadata read straight from the chain.
//
// There is no token-list server and no logo CDN. Symbols and decimals come from
// the token contract itself, which is also the only source that cannot lie to us
// about what the contract will actually do.
//
// Decimals in particular are read, never assumed. Mixing up 6 and 18 is the
// single most common way to lose money in a DeFi frontend, and the guess is
// always wrong for USDC.

import { hexToString, isAddress, getAddress } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import { NATIVE_CURRENCY, getChain } from '../chains/config.ts'
import { erc20Abi, erc20Bytes32Abi } from '../v4/abis.ts'
import { batchRead } from '../v4/reads.ts'

export interface TokenMetadata {
	readonly address: Address
	readonly symbol: string
	readonly name: string
	readonly decimals: number
	/** Native ETH, which has no contract to interrogate. */
	readonly isNative: boolean
}

/** Keyed by `${chainId}:${address}`. Metadata is immutable, so this never expires. */
const cache = new Map<string, TokenMetadata>()

function cacheKey(chainId: number, address: Address): string {
	return `${chainId}:${address.toLowerCase()}`
}

function decodeBytes32(value: Hex): string {
	// Trailing NULs are padding, not content.
	return hexToString(value).replace(/\0+$/, '')
}

function nativeMetadata(chainId: number): TokenMetadata {
	const chain = getChain(chainId)
	return {
		address: NATIVE_CURRENCY,
		symbol: chain?.nativeSymbol ?? 'ETH',
		name: 'Ether',
		decimals: 18,
		isNative: true,
	}
}

/**
 * Fetches metadata for several tokens in one batch.
 *
 * Tokens whose calls fail are omitted rather than defaulted. A token we cannot
 * read decimals for is a token we must not let the user trade, because every
 * amount we display or encode would be wrong.
 */
export async function fetchTokenMetadata(
	client: PublicClient,
	chainId: number,
	addresses: readonly Address[],
	useMulticall: boolean,
): Promise<Map<string, TokenMetadata>> {
	const found = new Map<string, TokenMetadata>()
	const missing: Address[] = []

	for (const address of addresses) {
		if (address.toLowerCase() === NATIVE_CURRENCY) {
			const native = nativeMetadata(chainId)
			found.set(NATIVE_CURRENCY, native)
			continue
		}
		const cached = cache.get(cacheKey(chainId, address))
		if (cached !== undefined) found.set(address.toLowerCase(), cached)
		else missing.push(address)
	}

	if (missing.length === 0) return found

	const calls = missing.flatMap(address => ([
		{ address, abi: erc20Abi, functionName: 'symbol' },
		{ address, abi: erc20Abi, functionName: 'name' },
		{ address, abi: erc20Abi, functionName: 'decimals' },
	]))
	const results = await batchRead(client, calls, useMulticall)

	// Tokens that answered symbol()/name() as bytes32 rather than string need a
	// second pass with a different ABI. MKR is the classic example.
	const needsBytes32: Address[] = []

	for (const [index, address] of missing.entries()) {
		const symbol = results[index * 3]
		const name = results[index * 3 + 1]
		const decimals = results[index * 3 + 2]

		if (decimals?.status !== 'success') continue // unreadable: skip entirely

		if (symbol?.status !== 'success' || name?.status !== 'success') {
			needsBytes32.push(address)
			continue
		}

		const metadata: TokenMetadata = {
			address: getAddress(address),
			symbol: symbol.result as string,
			name: name.result as string,
			decimals: Number(decimals.result),
			isNative: false,
		}
		cache.set(cacheKey(chainId, address), metadata)
		found.set(address.toLowerCase(), metadata)
	}

	if (needsBytes32.length > 0) {
		const retryCalls = needsBytes32.flatMap(address => ([
			{ address, abi: erc20Bytes32Abi, functionName: 'symbol' },
			{ address, abi: erc20Bytes32Abi, functionName: 'name' },
			{ address, abi: erc20Abi, functionName: 'decimals' },
		]))
		const retried = await batchRead(client, retryCalls, useMulticall)

		for (const [index, address] of needsBytes32.entries()) {
			const symbol = retried[index * 3]
			const name = retried[index * 3 + 1]
			const decimals = retried[index * 3 + 2]
			if (decimals?.status !== 'success') continue

			const metadata: TokenMetadata = {
				address: getAddress(address),
				symbol: symbol?.status === 'success' ? decodeBytes32(symbol.result as Hex) : '???',
				name: name?.status === 'success' ? decodeBytes32(name.result as Hex) : 'Unknown token',
				decimals: Number(decimals.result),
				isNative: false,
			}
			cache.set(cacheKey(chainId, address), metadata)
			found.set(address.toLowerCase(), metadata)
		}
	}

	return found
}

/** Validates and checksums user-pasted addresses. */
export function parseTokenAddress(input: string): Address | undefined {
	const trimmed = input.trim()
	if (!isAddress(trimmed)) return undefined
	return getAddress(trimmed)
}

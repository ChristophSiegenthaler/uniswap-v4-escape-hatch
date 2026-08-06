// Batched contract reads.
//
// Discovery fans out to dozens of eth_calls (four fee tiers x two reads x every
// candidate hop). A wallet's RPC is a shared, rate-limited resource, so we fold
// them into a single Multicall3 call where possible.
//
// Multicall3 is present at the same address on all five supported chains, but the
// user's RPC is still allowed to surprise us, so there is a sequential fallback.
// Nothing here is required for the emergency exit, which reads a handful of
// values directly.

import type { PublicClient } from 'viem'

export type ReadResult<T> =
	| { readonly status: 'success'; readonly result: T }
	| { readonly status: 'failure'; readonly error: Error }

interface ContractCall {
	address: `0x${string}`
	abi: readonly unknown[]
	functionName: string
	args?: readonly unknown[]
}

/**
 * Reads many contract calls, batching through Multicall3 when the chain and RPC
 * support it. Individual failures are returned rather than thrown: a candidate
 * pool that does not exist is an expected outcome, not an error.
 */
export async function batchRead<T = unknown>(
	client: PublicClient,
	calls: readonly ContractCall[],
	useMulticall: boolean,
): Promise<ReadResult<T>[]> {
	if (calls.length === 0) return []

	if (useMulticall) {
		try {
			// viem's multicall is generic over a literal contracts tuple; we pass a
			// dynamic array, so the inferred return collapses to never. The runtime
			// shape is stable and documented, so we name it explicitly.
			const results = await client.multicall({
				contracts: calls as never,
				allowFailure: true,
			}) as unknown as readonly (
				| { status: 'success'; result: unknown }
				| { status: 'failure'; error: unknown }
			)[]
			return results.map((entry): ReadResult<T> => entry.status === 'success'
				? { status: 'success', result: entry.result as T }
				: { status: 'failure', error: entry.error as Error })
		} catch (error) {
			// The batch itself failed (RPC refused the call, gas cap, size limit).
			// Fall through to sequential rather than reporting every pool as absent.
			console.warn(`multicall batch failed, falling back to sequential reads: ${(error as Error).message}`)
		}
	}

	return Promise.all(calls.map(async (call): Promise<ReadResult<T>> => {
		try {
			return { status: 'success', result: await client.readContract(call as never) as T }
		} catch (error) {
			return { status: 'failure', error: error as Error }
		}
	}))
}

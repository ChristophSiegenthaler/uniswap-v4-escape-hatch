// Translates wallet and contract errors into text a person can act on.
//
// frontend-ux Rule 7: never surface a raw revert selector or fail silently. Every
// path here ends in a sentence, and unknown errors still produce something
// specific enough to be worth reading.

export interface FriendlyError {
	/** Shown to the user. */
	message: string
	/** True when the user chose this (rejected the prompt), so we can stay quiet. */
	userRejected: boolean
	/** Raw detail, kept for a "details" disclosure rather than thrown away. */
	detail: string
}

/** EIP-1193 and common JSON-RPC error codes. */
const CODE_MESSAGES: Record<number, string> = {
	4001: 'You rejected the request in your wallet.',
	4100: 'Your wallet has not authorised this account. Unlock it and try again.',
	4200: 'Your wallet does not support this request.',
	4900: 'Your wallet is disconnected from the network.',
	4901: 'Your wallet is not connected to the requested chain.',
	[-32000]: 'The node rejected the request. You may not have enough ETH for gas.',
	[-32002]: 'Your wallet already has a pending request. Open it and respond there.',
	[-32003]: 'The transaction was rejected by the node.',
	[-32603]: 'Your wallet reported an internal error.',
}

/** Substring matches for errors that arrive as prose rather than a code. */
const TEXT_MATCHES: readonly (readonly [RegExp, string])[] = [
	[/user (rejected|denied|cancelled)/i, 'You rejected the request in your wallet.'],
	[/insufficient funds/i, 'Not enough ETH to cover the transaction and gas.'],
	[/gas required exceeds|out of gas/i, 'The transaction needs more gas than the limit allows.'],
	[/nonce too low/i, 'That transaction was already submitted. Refresh and try again.'],
	[/replacement transaction underpriced/i, 'A replacement needs a higher gas price than the pending transaction.'],
	[/deadline|expired/i, 'The transaction deadline passed before it was mined. Try again.'],
	[/slippage|too little received|too much requested/i, 'The price moved past your slippage limit. Nothing was swapped.'],
	[/execution reverted/i, 'The contract rejected the transaction.'],
	[/rate.?limit|too many requests/i, "Your wallet's RPC is rate-limiting us. Wait a moment and retry."],
	[/method .* not (supported|found|available)/i, "Your wallet's RPC does not support that request."],
]

function extractCode(error: unknown): number | undefined {
	if (error === null || typeof error !== 'object') return undefined
	const candidate = error as { code?: unknown; cause?: unknown }
	if (typeof candidate.code === 'number') return candidate.code
	if (candidate.cause !== undefined && candidate.cause !== error) return extractCode(candidate.cause)
	return undefined
}

function extractMessage(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	if (error !== null && typeof error === 'object') {
		const candidate = error as { message?: unknown }
		if (typeof candidate.message === 'string') return candidate.message
	}
	return String(error)
}

export function toFriendlyError(error: unknown): FriendlyError {
	const detail = extractMessage(error)
	const code = extractCode(error)

	const userRejected = code === 4001 || /user (rejected|denied|cancelled)/i.test(detail)

	if (code !== undefined) {
		const byCode = CODE_MESSAGES[code]
		if (byCode !== undefined) return { message: byCode, userRejected, detail }
	}

	for (const [pattern, message] of TEXT_MATCHES) {
		if (pattern.test(detail)) return { message, userRejected, detail }
	}

	// Unknown, but a bare selector is useless on its own -- say so explicitly
	// rather than printing hex at the user.
	const selector = /0x[0-9a-f]{8}\b/i.exec(detail)
	if (selector !== null) {
		return {
			message: `The contract rejected the transaction with an error we do not recognise (${selector[0]}).`,
			userRejected,
			detail,
		}
	}

	return { message: 'Something went wrong. See details for the raw error.', userRejected, detail }
}

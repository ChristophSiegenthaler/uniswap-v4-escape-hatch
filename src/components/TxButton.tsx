// A button for actions that touch the chain.
//
// Implements the double-submit guard the QA checklist calls ship-blocking. Two
// separate flags are needed, and this is the reason:
//
//   submitting  set the instant the handler runs, cleared in finally{}
//   cooldown    set AFTER confirmation, cleared a few seconds later
//
// A wallet's "pending" signal clears when the tx hash comes back, which is
// *before* the chain state that the UI reads has caught up. Without the cooldown
// there is a window where the button looks ready again and a second click sends a
// duplicate transaction. One flag cannot cover both halves.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

interface TxButtonProps {
	label: string
	/** Shown while the action is in flight, e.g. "Approving...". */
	pendingLabel: string
	onClick: () => Promise<void>
	disabled?: boolean
	/** Seconds to stay locked after success, covering the confirmation->read gap. */
	cooldownMs?: number
	children?: ComponentChildren
}

export function TxButton({ label, pendingLabel, onClick, disabled = false, cooldownMs = 4000 }: TxButtonProps) {
	const [submitting, setSubmitting] = useState(false)
	const [cooling, setCooling] = useState(false)
	const mounted = useRef(true)
	const timer = useRef<ReturnType<typeof setTimeout>>()

	useEffect(() => () => {
		mounted.current = false
		if (timer.current !== undefined) clearTimeout(timer.current)
	}, [])

	const handle = useCallback(async () => {
		if (submitting || cooling) return
		setSubmitting(true)
		try {
			await onClick()
			if (!mounted.current) return
			setCooling(true)
			timer.current = setTimeout(() => { if (mounted.current) setCooling(false) }, cooldownMs)
		} finally {
			// Always clears, including on throw -- otherwise a failed action leaves
			// the button permanently dead and the user has to reload.
			if (mounted.current) setSubmitting(false)
		}
	}, [onClick, submitting, cooling, cooldownMs])

	const busy = submitting || cooling
	return (
		<button
			class='btn-primary'
			disabled={disabled || busy}
			aria-busy={submitting}
			onClick={() => void handle()}
		>
			{submitting && <span class='spinner' aria-hidden='true' />}
			{submitting ? pendingLabel : label}
		</button>
	)
}

// Renders the built bundle in a headless DOM and drives it with a mock wallet.
//
// "It compiled" is not "it runs". Scenario 1 covers the disconnected view,
// scenario 2 announces a fake EIP-6963 wallet and clicks through connection, so
// the actual wallet plumbing is exercised rather than just the empty state.
//
//   node scripts/smoke-test.ts

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const pass = (msg: string) => console.log(`  ok    ${msg}`)

const html = readFileSync('dist/index.html', 'utf8')
const bundle = readFileSync('dist/app.js', 'utf8')

const TEST_ACCOUNT = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const tick = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))

interface Harness {
	window: JSDOM['window']
	text: () => string
	buttons: () => HTMLButtonElement[]
	networkCalls: string[]
	consoleErrors: string[]
}

function boot(): Harness {
	const dom = new JSDOM(html, { url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
	const { window } = dom

	// Any outbound call during a test is a failure; make them loud rather than
	// letting them quietly hit a real host.
	const networkCalls: string[] = []
	Object.defineProperty(window, 'fetch', {
		value: (input: unknown) => {
			networkCalls.push(String(input))
			return Promise.reject(new Error('network blocked in smoke test'))
		},
		writable: true,
	})
	window.XMLHttpRequest = class { open(_m: string, url: string) { networkCalls.push(url) } send() {} } as never

	const consoleErrors: string[] = []
	window.console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')) }

	// jsdom has no scrollIntoView.
	window.Element.prototype.scrollIntoView = function () {}

	window.eval(bundle)

	return {
		window,
		text: () => window.document.getElementById('app')?.textContent ?? '',
		buttons: () => [...window.document.querySelectorAll('button')] as HTMLButtonElement[],
		networkCalls,
		consoleErrors,
	}
}

/** A minimal EIP-1193 wallet whose RPC supports multicall but refuses getLogs. */
function mockProvider(chainIdHex: string, localNode = false) {
	const listeners = new Map<string, ((...args: never[]) => void)[]>()
	const seen: string[] = []
	return {
		seen,
		emit(event: string, payload: unknown) {
			for (const listener of listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload)
		},
		provider: {
			async request({ method }: { method: string }) {
				seen.push(method)
				switch (method) {
					case 'eth_requestAccounts': return [TEST_ACCOUNT]
					case 'eth_accounts': return []
					case 'eth_chainId': return chainIdHex
					case 'eth_blockNumber': return '0x188209f'
					case 'eth_getCode': return '0x6080604052'
					case 'eth_getLogs': throw Object.assign(new Error('method not supported'), { code: -32601 })
					case 'anvil_nodeInfo':
						if (localNode) return { currentBlockNumber: '0x1882283' }
						throw Object.assign(new Error('method does not exist'), { code: -32601 })
					case 'hardhat_metadata':
						throw Object.assign(new Error('method does not exist'), { code: -32601 })
					// 128 zero bytes: decodes as an uninitialised pool (sqrtPriceX96 == 0),
					// which is how an absent pool legitimately reads on chain.
					case 'eth_call': return `0x${'00'.repeat(128)}`
					default: throw new Error(`unexpected RPC method: ${method}`)
				}
			},
			on(event: string, listener: (...args: never[]) => void) {
				listeners.set(event, [...(listeners.get(event) ?? []), listener])
			},
			removeListener() {},
		},
	}
}

function announce(h: Harness, wallet: ReturnType<typeof mockProvider>, name = 'Mock Wallet') {
	h.window.dispatchEvent(new h.window.CustomEvent('eip6963:announceProvider', {
		detail: {
			info: { uuid: 'test-uuid', name, icon: 'data:image/svg+xml,<svg/>', rdns: 'test.mock' },
			provider: wallet.provider,
		},
	}))
}

// --- scenario 1: no wallet ---------------------------------------------------

console.log('Scenario 1: no wallet installed\n')
{
	const h = boot()
	await tick(600) // let the legacy-window.ethereum fallback timer elapse

	const app = h.window.document.getElementById('app')
	if (app === null || app.children.length === 0) fail('nothing rendered into #app')
	else pass(`rendered ${app.children.length} top-level node(s)`)

	if (h.text().includes('Uniswap v4 Escape Hatch')) pass('heading rendered')
	else fail('heading not rendered')

	if (h.buttons().length > 0) pass(`${h.buttons().length} button(s) rendered while disconnected`)
	else fail('no <button> while disconnected — the QA checklist calls this ship-blocking')

	if (h.text().includes('No browser wallet detected')) pass('states plainly that no wallet was found')
	else fail('missing the no-wallet explanation')

	// A button that does nothing when clicked is worse than no button.
	const connect = h.buttons().find(b => b.textContent?.includes('No wallet detected'))
	if (connect?.disabled === true) pass('connect action is disabled when there is nothing to connect to')
	else fail('connect action should be disabled with no wallet present')

	if (h.networkCalls.length === 0) pass('no network activity during render')
	else fail(`network calls during render: ${h.networkCalls.join(', ')}`)
}

// --- scenario 2: wallet on a supported chain ---------------------------------

console.log('\nScenario 2: wallet on Ethereum mainnet\n')
{
	const h = boot()
	// The discovery listener is registered in a useEffect, so it does not exist
	// until after the first paint. Announce only once the app has settled.
	await tick()
	const wallet = mockProvider('0x1')
	announce(h, wallet)
	await tick()

	const option = h.buttons().find(b => b.textContent?.includes('Mock Wallet'))
	if (option === undefined) {
		fail('announced wallet did not appear in the picker')
	} else {
		pass('EIP-6963 announcement discovered')
		option.click()
		await tick(500)

		const text = h.text()
		// Address must render checksummed and truncated, not raw lowercase.
		if (text.includes('0xd8dA...6045')) pass('address shown checksummed and truncated')
		else fail(`address not rendered as expected; got: ${text.slice(0, 400)}`)

		if (text.includes('Ethereum (1)')) pass('chain identified as Ethereum')
		else fail('chain not identified')

		if (text.includes('25698463')) pass('block number polled and displayed')
		else fail('block number not displayed')

		// Capability probing: multicall present, getLogs refused.
		if (/Batched reads[\s\S]*?available/.test(text)) pass('multicall detected as available')
		else fail('multicall capability not reported')

		if (text.includes('Your RPC will not serve logs')) pass('degrades honestly when getLogs is unsupported')
		else fail('missing the no-logs explanation')

		if (wallet.seen.includes('eth_requestAccounts')) pass('requested accounts via EIP-1193')
		else fail('never called eth_requestAccounts')

		if (h.networkCalls.length === 0) pass('still no outbound HTTP — wallet is the only peer')
		else fail(`outbound HTTP after connect: ${h.networkCalls.join(', ')}`)

		if (text.includes('Pool discovery')) pass('pool discovery panel rendered once on a supported chain')
		else fail('pool discovery panel missing')

		if (h.consoleErrors.length === 0) pass('no console errors')
		else fail(`console errors: ${h.consoleErrors.join(' | ')}`)
	}
}

// --- scenario 4: discovery finds nothing, and says so honestly ---------------

console.log('\nScenario 4: pool discovery with no pools present\n')
{
	const h = boot()
	await tick()
	announce(h, mockProvider('0x1'))
	await tick()
	h.buttons().find(b => b.textContent?.includes('Mock Wallet'))?.click()
	await tick(400)

	const find = h.buttons().find(b => b.textContent?.includes('Find pools'))
	if (find === undefined) {
		fail('no "Find pools" button')
	} else {
		pass('discovery form rendered with a search action')
		find.click()
		await tick(600)

		const text = h.text()
		// The honest empty state matters: absence of a hookless pool at a
		// conventional tier is NOT proof that no pool exists.
		if (text.includes('No hookless pool found')) pass('empty result stated honestly')
		else fail(`expected the honest empty state; got: ${text.slice(-300)}`)

		if (text.includes('hook pools cannot be enumerated')) pass('explains that hook pools are unenumerable')
		else fail('empty state does not mention the hook-pool limitation')

		if (h.networkCalls.length === 0) pass('discovery made no outbound HTTP')
		else fail(`discovery reached out: ${h.networkCalls.join(', ')}`)
	}
}

// --- scenario 3: wallet on an unsupported chain ------------------------------

console.log('\nScenario 3: wallet on an unsupported chain\n')
{
	const h = boot()
	await tick()
	const wallet = mockProvider('0x89') // Polygon: real chain, not in our config
	announce(h, wallet)
	await tick()

	const option = h.buttons().find(b => b.textContent?.includes('Mock Wallet'))
	option?.click()
	await tick(500)

	const text = h.text()
	if (text.includes('no Uniswap v4 deployment in our')) pass('warns that the chain is unsupported')
	else fail('no unsupported-chain warning')

	const switchButton = h.buttons().find(b => b.textContent?.startsWith('Switch to'))
	if (switchButton !== undefined) pass(`primary action became "${switchButton.textContent}"`)
	else fail('primary action did not become a Switch button on an unsupported chain')
}

// --- scenario 5: emergency exit on an already-closed position ---------------

console.log('\nScenario 5: emergency exit UI\n')
{
	const h = boot()
	await tick()
	announce(h, mockProvider('0x1'))
	await tick()
	h.buttons().find(b => b.textContent?.includes('Mock Wallet'))?.click()
	await tick(400)

	if (h.text().includes('Emergency exit')) pass('emergency exit panel rendered')
	else fail('emergency exit panel missing')

	// It must be usable without Uniswap's site, so it has to say where to find the id.
	if (h.text().includes('block explorer will show it')) pass('explains how to find a position id without Uniswap')
	else fail('missing guidance on finding a position id')

	const field = h.window.document.querySelector('input.input') as HTMLInputElement | null
	const lookup = h.buttons().find(b => b.textContent?.includes('Look up position'))
	if (field === null || lookup === undefined) {
		fail('exit form not usable')
	} else {
		field.value = '340000'
		field.dispatchEvent(new h.window.Event('input', { bubbles: true }))
		await tick(150)
		lookup.click()
		await tick(500)

		// positionInfo reads back as zero, which means burned or never minted --
		// a normal state that must never surface as an error.
		if (h.text().includes('is already closed')) pass('closed position reported as closed, not as an error')
		else fail(`expected the already-closed state; got: ${h.text().slice(-300)}`)

		if (h.networkCalls.length === 0) pass('exit lookup made no outbound HTTP')
		else fail(`exit lookup reached out: ${h.networkCalls.join(', ')}`)
	}

	if (h.consoleErrors.length === 0) pass('no console errors')
	else fail(`console errors: ${h.consoleErrors.join(' | ')}`)
}

// --- scenario 6: a forked node must not masquerade as the real chain ---------

console.log('\nScenario 6: local fork claiming to be mainnet\n')
{
	const h = boot()
	await tick()
	announce(h, mockProvider('0x1', true))
	await tick()
	h.buttons().find(b => b.textContent?.includes('Mock Wallet'))?.click()
	await tick(500)

	const text = h.text()
	// A mainnet fork reports chain id 1, so nothing else distinguishes it.
	if (text.includes('Local development node')) pass('local node detected and announced')
	else fail('a fork claiming chain id 1 was presented as real Ethereum')

	if (text.includes('not to Ethereum')) pass('names the chain it is impersonating')
	else fail('banner does not say which network it is standing in for')
}

// A real endpoint must NOT be flagged as local.
{
	const h = boot()
	await tick()
	announce(h, mockProvider('0x1', false))
	await tick()
	h.buttons().find(b => b.textContent?.includes('Mock Wallet'))?.click()
	await tick(500)

	if (!h.text().includes('Local development node')) pass('a real endpoint is not mislabelled as local')
	else fail('real endpoint wrongly flagged as a local node')
}

console.log(failures === 0 ? '\nSmoke test passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

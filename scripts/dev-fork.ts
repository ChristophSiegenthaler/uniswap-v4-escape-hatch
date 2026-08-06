// Sets up a local mainnet fork you can drive from your own wallet.
//
// The problem this solves: to test the emergency exit for real you need a
// position you can sign for, and you do not own any of the live mainnet ones.
// So we fork mainnet, then hand you one.
//
// It transfers a real, funded v4 position to YOUR address on the fork, so you
// sign with your own wallet and never import a test private key. Nothing here
// touches real mainnet -- the fork is a local copy that disappears on Ctrl-C.
//
//   node scripts/dev-fork.ts --to 0xYourWalletAddress
//   node scripts/dev-fork.ts --to 0xYour... --token-id 365000
//
// Leave it running, then open the app in another terminal with `npm run dev`.

import { spawn } from 'node:child_process'
import { createPublicClient, encodeFunctionData, http, isAddress, getAddress } from 'viem'
import type { Address, PublicClient } from 'viem'
import { VERIFY_RPCS } from './verify-rpcs.ts'
import { viemChain } from '../src/wallet/chains.ts'
import { CHAINS, NATIVE_CURRENCY } from '../src/chains/config.ts'
import { positionManagerAbi } from '../src/v4/abis.ts'
import { readPosition } from '../src/v4/positions.ts'

const PORT = 8545
const URL = `http://127.0.0.1:${PORT}`
const POSITION_MANAGER = CHAINS[1]!.contracts.positionManager

// Candidate live positions with liquidity: hookless first, then a hook pool.
const DEFAULT_CANDIDATES = [365000n, 365200n, 365401n, 364900n]

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? undefined : process.argv[index + 1]
}

const rawTo = arg('to')
if (rawTo === undefined || !isAddress(rawTo)) {
	console.error(`
Usage: node scripts/dev-fork.ts --to 0xYourWalletAddress [--token-id 365000]

  --to        the address you will connect with. A real mainnet position gets
              transferred to it on the fork, so you can exit it from your own
              wallet without importing any private key.
  --token-id  a specific position to hand over. Defaults to a funded one.
`)
	process.exit(1)
}
const recipient = getAddress(rawTo)

console.log('Starting anvil fork of mainnet...\n')

// --chain-id 31337 is required, not optional.
//
// When forking, anvil ADOPTS the forked chain's id -- a mainnet fork reports 1 by
// default. MetaMask refuses to add a second network claiming an id it already
// knows, so such a fork cannot be added to the wallet at all. Overriding to
// anvil's own id makes it addable; the app then works out what was forked by
// probing which PoolManager has bytecode, so the contracts still resolve.
const FORK_CHAIN_ID = 31337
const anvil = spawn('anvil', [
	'--fork-url', VERIFY_RPCS[1]!,
	'--port', String(PORT),
	'--chain-id', String(FORK_CHAIN_ID),
	'--silent',
	'--no-rate-limit',
], { stdio: ['ignore', 'ignore', 'inherit'] })

const shutdown = () => { if (!anvil.killed) anvil.kill('SIGTERM') }
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(0) })

async function rpc(method: string, params: unknown[]): Promise<unknown> {
	const res = await fetch(URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	})
	const json = await res.json() as { result?: unknown; error?: { message: string } }
	if (json.error) throw new Error(json.error.message)
	return json.result
}

for (let attempt = 0; ; attempt++) {
	try { await rpc('eth_chainId', []); break } catch {
		if (attempt > 60) { console.error('anvil did not start'); process.exit(1) }
		await new Promise(resolve => setTimeout(resolve, 1000))
	}
}

const forkChainId = Number(await rpc('eth_chainId', []) as string)
const client = createPublicClient({
	chain: viemChain(forkChainId, 1), transport: http(URL),
}) as PublicClient
console.log(`Forked mainnet at block ${await client.getBlockNumber()} (fork reports chain id ${forkChainId})\n`)

// Pick a position that still has liquidity.
const explicit = arg('token-id')
const candidates = explicit !== undefined ? [BigInt(explicit)] : DEFAULT_CANDIDATES

let chosen: Awaited<ReturnType<typeof readPosition>> | undefined
let chosenId: bigint | undefined
for (const tokenId of candidates) {
	const lookup = await readPosition(client, 1, tokenId, true)
	if (lookup.status === 'found' && (explicit !== undefined || lookup.position.liquidity > 0n)) {
		chosen = lookup
		chosenId = tokenId
		break
	}
}

if (chosen === undefined || chosen.status !== 'found' || chosenId === undefined) {
	console.error('Could not find a usable position to hand over.')
	process.exit(1)
}

const position = chosen.position
const hooked = position.poolKey.hooks.toLowerCase() !== NATIVE_CURRENCY

// Give both the current owner and you enough ETH for gas on the fork.
await rpc('anvil_setBalance', [position.owner, '0x56BC75E2D63100000'])
await rpc('anvil_setBalance', [recipient, '0x56BC75E2D63100000'])
await rpc('anvil_impersonateAccount', [position.owner])

const transferHash = await rpc('eth_sendTransaction', [{
	from: position.owner,
	to: POSITION_MANAGER,
	data: encodeFunctionData({
		abi: [{
			type: 'function', name: 'transferFrom', stateMutability: 'nonpayable',
			inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [],
		}],
		functionName: 'transferFrom',
		args: [position.owner, recipient, chosenId],
	}),
	gas: '0x100000',
}])
await client.waitForTransactionReceipt({ hash: transferHash as `0x${string}` })
await rpc('anvil_stopImpersonatingAccount', [position.owner])

const newOwner = await client.readContract({
	address: POSITION_MANAGER, abi: positionManagerAbi,
	functionName: 'ownerOf', args: [chosenId],
}) as Address

if (newOwner.toLowerCase() !== recipient.toLowerCase()) {
	console.error(`Transfer failed: position is still owned by ${newOwner}`)
	process.exit(1)
}

console.log(`
────────────────────────────────────────────────────────────────
  Fork ready. Position #${chosenId} now belongs to you.
────────────────────────────────────────────────────────────────

  Pool        ${position.poolKey.currency0.slice(0, 10)}… / ${position.poolKey.currency1.slice(0, 10)}…
  Fee tier    ${(position.poolKey.fee / 10_000).toFixed(4)}%
  Hook        ${hooked ? position.poolKey.hooks : 'none'}
  Liquidity   ${position.liquidity}
  Balance     100 ETH (for gas)

  1. Add this network to your wallet, then SELECT it:
       RPC URL   ${URL}
       Chain ID  ${forkChainId}
       Symbol    ETH

     The fork reports ${forkChainId} rather than 1 on purpose: a wallet will not
     accept a second network claiming to be Ethereum. The app identifies it as
     a fork of Ethereum from the deployed bytecode and says so in a banner.

     Selecting the network matters as much as adding it -- if your wallet stays
     on mainnet you will see mainnet's data, and this position will correctly
     appear to belong to somebody else.

  2. In another terminal:  npm run dev
  3. Open http://127.0.0.1:8000 and connect with ${recipient.slice(0, 10)}…
  4. Enter position id ${chosenId} and withdraw it.

  Ctrl-C to tear the fork down.
`)

// Hold the fork open.
await new Promise(() => {})

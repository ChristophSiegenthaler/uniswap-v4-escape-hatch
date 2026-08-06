// Dev-only RPC endpoints, used exclusively by scripts/verify-addresses.ts.
//
// Application code MUST NOT import this file. The shipped app talks only to the
// user's wallet provider; bundling a URL from here would silently reintroduce a
// third-party network dependency. scripts/check-no-network.ts enforces that the
// built bundle contains no URLs.

export const VERIFY_RPCS: Readonly<Record<number, string>> = {
	1: 'https://ethereum-rpc.publicnode.com',
	10: 'https://optimism-rpc.publicnode.com',
	130: 'https://unichain-rpc.publicnode.com',
	8453: 'https://base-rpc.publicnode.com',
	42161: 'https://arbitrum-one-rpc.publicnode.com',
}

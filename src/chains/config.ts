// Uniswap v4 deployment addresses, pinned and verified onchain.
//
// Every address here has been confirmed to hold bytecode on its chain, and the
// bytecode sizes are identical across chains for each contract (StateView 3531b,
// V4Quoter 5820b, PoolManager 24009b, PositionManager 23877b, UniversalRouter
// 19499b, Multicall3 3808b), which is strong evidence these are the genuine
// deployments rather than addresses that merely happen to hold code.
//
// Re-verify with: node scripts/verify-addresses.ts
//
// This file must stay free of RPC URLs: it is imported by application code, and
// any URL here would be bundled into the shipped app, breaking the promise that
// the only network peer is the user's wallet. Dev-only RPCs live in
// scripts/verify-rpcs.ts, which application code never imports.

export type Address = `0x${string}`

export interface TokenInfo {
	readonly address: Address
	readonly symbol: string
	readonly decimals: number
}

export interface ChainConfig {
	readonly chainId: number
	readonly name: string
	/** Native currency symbol. In v4 native ETH is currency address(0), not WETH. */
	readonly nativeSymbol: string
	readonly contracts: {
		readonly poolManager: Address
		readonly positionManager: Address
		readonly stateView: Address
		readonly quoter: Address
		readonly universalRouter: Address
		readonly permit2: Address
		readonly multicall3: Address
	}
	/** Intermediate hops for local route search. Ordered by expected liquidity. */
	readonly baseTokens: readonly TokenInfo[]
	/**
	 * Runtime bytecode size of this chain's PoolManager, in bytes.
	 *
	 * Used to identify which chain a fork is standing in for. Presence of *any*
	 * code at the address is far too weak -- an unrelated contract could sit there
	 * on a foreign chain -- so we require the size to match too.
	 */
	readonly poolManagerCodeSize: number
	/**
	 * Block explorer, used only for user-initiated <a href> links. The page never
	 * fetches from it, so it costs nothing on load; clicking is the user's choice.
	 * scripts/check-no-network.ts allowlists exactly these hosts.
	 */
	readonly explorer: string
}

/** Permit2 is deployed at the same address on every chain. */
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/** Multicall3, same address on every chain we support. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** v4 represents native ETH as the zero address, not as WETH. */
export const NATIVE_CURRENCY: Address = '0x0000000000000000000000000000000000000000'

/**
 * Fee tiers to probe during pool discovery, paired with their conventional
 * tick spacing.
 *
 * IMPORTANT: unlike v3, v4 does NOT constrain fee or tickSpacing to a fixed set
 * -- the PoolKey carries both, and any pool creator may choose any values.
 * Sampling live mainnet positions turned up pools at (10,1), (45,1), (31800,10),
 * (50000,500), (150000,13) and (999950,76), none of which are in this list.
 *
 * So this set is a heuristic for *discovery* only: it finds the deep, canonical
 * pools that carry most volume. It is not exhaustive and cannot be. Pools
 * outside it are reachable via manual PoolKey entry, and -- critically -- the
 * emergency exit path never relies on discovery at all, because it recovers the
 * exact PoolKey from PositionManager.poolKeys().
 */
export const CANONICAL_FEE_TIERS: readonly { fee: number; tickSpacing: number }[] = [
	{ fee: 100, tickSpacing: 1 },
	{ fee: 500, tickSpacing: 10 },
	{ fee: 3000, tickSpacing: 60 },
	{ fee: 10000, tickSpacing: 200 },
]

/** Set on PoolKey.fee to mark a pool whose hook supplies the fee per swap. */
export const DYNAMIC_FEE_FLAG = 0x800000

/** Maximum LP fee, 100% in hundredths of a bip. */
export const MAX_LP_FEE = 1_000_000

export const CHAINS: Readonly<Record<number, ChainConfig>> = {
	1: {
		chainId: 1,
		name: 'Ethereum',
		nativeSymbol: 'ETH',
		contracts: {
			poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
			positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
			stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
			quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
			universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
			permit2: PERMIT2,
			multicall3: MULTICALL3,
		},
		baseTokens: [
			{ address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
			{ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
			{ address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
			{ address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
		],
		poolManagerCodeSize: 24009,
		explorer: 'https://etherscan.io',
	},
	10: {
		chainId: 10,
		name: 'Optimism',
		nativeSymbol: 'ETH',
		contracts: {
			poolManager: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
			positionManager: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
			stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
			quoter: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7',
			universalRouter: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507',
			permit2: PERMIT2,
			multicall3: MULTICALL3,
		},
		baseTokens: [
			{ address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
			{ address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
			{ address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
		],
		poolManagerCodeSize: 24009,
		explorer: 'https://optimistic.etherscan.io',
	},
	130: {
		chainId: 130,
		name: 'Unichain',
		nativeSymbol: 'ETH',
		contracts: {
			poolManager: '0x1f98400000000000000000000000000000000004',
			positionManager: '0x4529a01c7a0410167c5740c487a8de60232617bf',
			stateView: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2',
			quoter: '0x333e3c607b141b18ff6de9f258db6e77fe7491e0',
			universalRouter: '0xef740bf23acae26f6492b10de645d6b98dc8eaf3',
			permit2: PERMIT2,
			multicall3: MULTICALL3,
		},
		baseTokens: [
			{ address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
			{ address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', symbol: 'USDC', decimals: 6 },
		],
		poolManagerCodeSize: 24050,
		explorer: 'https://uniscan.xyz',
	},
	8453: {
		chainId: 8453,
		name: 'Base',
		nativeSymbol: 'ETH',
		contracts: {
			poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
			positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
			stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
			quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
			universalRouter: '0x6ff5693b99212da76ad316178a184ab56d299b43',
			permit2: PERMIT2,
			multicall3: MULTICALL3,
		},
		baseTokens: [
			{ address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
			{ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
		],
		poolManagerCodeSize: 24009,
		explorer: 'https://basescan.org',
	},
	42161: {
		chainId: 42161,
		name: 'Arbitrum One',
		nativeSymbol: 'ETH',
		contracts: {
			poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
			positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
			stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
			quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
			universalRouter: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3',
			permit2: PERMIT2,
			multicall3: MULTICALL3,
		},
		baseTokens: [
			{ address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
			{ address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
			// Tether's bridged token on Arbitrum reports symbol "USD₮0" onchain, not "USDT".
			{ address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USD₮0', decimals: 6 },
		],
		poolManagerCodeSize: 24009,
		explorer: 'https://arbiscan.io',
	},
}

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number)

export function getChain(chainId: number): ChainConfig | undefined {
	return CHAINS[chainId]
}

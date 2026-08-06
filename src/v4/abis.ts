// Hand-written minimal ABIs.
//
// Only the functions we actually call, each one exercised against mainnet during
// M0/M2 rather than copied from documentation. Notably getSlot0's fee fields are
// uint24 -- the Uniswap docs say uint8, which is wrong and would truncate every
// fee above 255. See docs/m0-verified-facts.md.

export const stateViewAbi = [
	{
		type: 'function', name: 'getSlot0', stateMutability: 'view',
		inputs: [{ name: 'poolId', type: 'bytes32' }],
		outputs: [
			{ name: 'sqrtPriceX96', type: 'uint160' },
			{ name: 'tick', type: 'int24' },
			{ name: 'protocolFee', type: 'uint24' },
			{ name: 'lpFee', type: 'uint24' },
		],
	},
	{
		type: 'function', name: 'getLiquidity', stateMutability: 'view',
		inputs: [{ name: 'poolId', type: 'bytes32' }],
		outputs: [{ name: 'liquidity', type: 'uint128' }],
	},
	{
		type: 'function', name: 'getTickLiquidity', stateMutability: 'view',
		inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'tick', type: 'int24' }],
		outputs: [
			{ name: 'liquidityGross', type: 'uint128' },
			{ name: 'liquidityNet', type: 'int128' },
		],
	},
	{
		type: 'function', name: 'getTickBitmap', stateMutability: 'view',
		inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'word', type: 'int16' }],
		outputs: [{ name: 'tickBitmap', type: 'uint256' }],
	},
	{
		type: 'function', name: 'poolManager', stateMutability: 'view',
		inputs: [], outputs: [{ type: 'address' }],
	},
] as const

export const positionManagerAbi = [
	{
		type: 'function', name: 'nextTokenId', stateMutability: 'view',
		inputs: [], outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function', name: 'ownerOf', stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }],
	},
	{
		type: 'function', name: 'balanceOf', stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function', name: 'getPositionLiquidity', stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint128' }],
	},
	{
		// Returns the packed PositionInfo. Unpacking rules in poolKey.ts.
		type: 'function', name: 'positionInfo', stateMutability: 'view',
		inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint256' }],
	},
	{
		// The key to the whole emergency exit: recovers a full PoolKey from the
		// truncated pool id stored in a position.
		type: 'function', name: 'poolKeys', stateMutability: 'view',
		inputs: [{ name: 'poolId', type: 'bytes25' }],
		outputs: [
			{ name: 'currency0', type: 'address' },
			{ name: 'currency1', type: 'address' },
			{ name: 'fee', type: 'uint24' },
			{ name: 'tickSpacing', type: 'int24' },
			{ name: 'hooks', type: 'address' },
		],
	},
	{
		type: 'function', name: 'modifyLiquidities', stateMutability: 'payable',
		inputs: [{ name: 'unlockData', type: 'bytes' }, { name: 'deadline', type: 'uint256' }],
		outputs: [],
	},
] as const

/**
 * V4Quoter. quoteExactInputSingle is state-mutating by design (it reverts to
 * return its result) but is called via eth_call. Verified working on mainnet:
 * 1 ETH -> 1905.12 USDC at ~42k gas, so wallet eth_call gas caps are not a
 * concern for a single hop.
 *
 * Note the parameter is a FLAT tuple -- the PoolKey is not double-wrapped.
 */
export const quoterAbi = [
	{
		type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
		inputs: [{
			name: 'params', type: 'tuple',
			components: [
				{
					name: 'poolKey', type: 'tuple', components: [
						{ name: 'currency0', type: 'address' },
						{ name: 'currency1', type: 'address' },
						{ name: 'fee', type: 'uint24' },
						{ name: 'tickSpacing', type: 'int24' },
						{ name: 'hooks', type: 'address' },
					],
				},
				{ name: 'zeroForOne', type: 'bool' },
				{ name: 'exactAmount', type: 'uint128' },
				{ name: 'hookData', type: 'bytes' },
			],
		}],
		outputs: [
			{ name: 'amountOut', type: 'uint256' },
			{ name: 'gasEstimate', type: 'uint256' },
		],
	},
] as const

export const erc20Abi = [
	{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{
		type: 'function', name: 'balanceOf', stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function', name: 'allowance', stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
] as const

/**
 * Some pre-standard tokens (MKR being the canonical case) return a bytes32 from
 * symbol()/name() instead of a string. Decoding those with the string ABI throws,
 * so we retry with this one.
 */
export const erc20Bytes32Abi = [
	{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const

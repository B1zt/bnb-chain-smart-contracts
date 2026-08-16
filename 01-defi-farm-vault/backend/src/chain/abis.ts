/**
 * Hand-maintained ABI fragments: only what the backend reads or indexes.
 *
 * `as const` keeps viem's inference exact, so event args and call returns are fully typed.
 */

export const masterChefAbi = [
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      {name: 'user', type: 'address', indexed: true},
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'fee', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      {name: 'user', type: 'address', indexed: true},
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Harvest',
    inputs: [
      {name: 'user', type: 'address', indexed: true},
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'EmergencyWithdraw',
    inputs: [
      {name: 'user', type: 'address', indexed: true},
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'PoolAdded',
    inputs: [
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'lpToken', type: 'address', indexed: true},
      {name: 'allocPoint', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'PoolUpdated',
    inputs: [
      {name: 'pid', type: 'uint256', indexed: true},
      {name: 'allocPoint', type: 'uint256', indexed: false},
      {name: 'depositFeeBps', type: 'uint16', indexed: false},
      {name: 'harvestLockup', type: 'uint32', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'poolLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'poolInfo',
    stateMutability: 'view',
    inputs: [{name: 'pid', type: 'uint256'}],
    outputs: [
      {name: 'lpToken', type: 'address'},
      {name: 'allocPoint', type: 'uint256'},
      {name: 'lastRewardTime', type: 'uint256'},
      {name: 'accRewardPerShare', type: 'uint256'},
      {name: 'depositFeeBps', type: 'uint16'},
      {name: 'harvestLockup', type: 'uint32'},
      {name: 'lpSupply', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'userInfo',
    stateMutability: 'view',
    inputs: [
      {name: 'pid', type: 'uint256'},
      {name: 'user', type: 'address'},
    ],
    outputs: [
      {name: 'amount', type: 'uint256'},
      {name: 'rewardDebt', type: 'uint256'},
      {name: 'nextHarvestAt', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'pendingReward',
    stateMutability: 'view',
    inputs: [
      {name: 'pid', type: 'uint256'},
      {name: 'account', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'poolRewardPerSecond',
    stateMutability: 'view',
    inputs: [{name: 'pid', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'rewardPerSecond',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalAllocPoint',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'harvestUnlockIn',
    stateMutability: 'view',
    inputs: [
      {name: 'pid', type: 'uint256'},
      {name: 'account', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const vaultAbi = [
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      {name: 'sender', type: 'address', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
      {name: 'assets', type: 'uint256', indexed: false},
      {name: 'shares', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      {name: 'sender', type: 'address', indexed: true},
      {name: 'receiver', type: 'address', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
      {name: 'assets', type: 'uint256', indexed: false},
      {name: 'shares', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Compounded',
    inputs: [
      {name: 'caller', type: 'address', indexed: true},
      {name: 'rewardHarvested', type: 'uint256', indexed: false},
      {name: 'lpAdded', type: 'uint256', indexed: false},
      {name: 'callerBounty', type: 'uint256', indexed: false},
      {name: 'performanceFee', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'compound',
    stateMutability: 'nonpayable',
    inputs: [{name: 'deadline', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'callerBounty',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'pendingRewards',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'pricePerShare',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{name: 'shares', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'timeSinceCompound',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'bool'}],
  },
] as const;

export const pairAbi = [
  {type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {name: 'reserve0', type: 'uint112'},
      {name: 'reserve1', type: 'uint112'},
      {name: 'blockTimestampLast', type: 'uint32'},
    ],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const erc20Abi = [
  {type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
  {type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{type: 'uint8'}]},
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const routerAbi = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      {name: 'amountIn', type: 'uint256'},
      {name: 'path', type: 'address[]'},
    ],
    outputs: [{type: 'uint256[]'}],
  },
] as const;

export const oracleAbi = [
  {
    type: 'function',
    name: 'tryGetPrice',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [
      {name: 'ok', type: 'bool'},
      {name: 'price', type: 'uint256'},
    ],
  },
] as const;

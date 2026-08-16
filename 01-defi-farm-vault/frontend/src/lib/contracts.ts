import type {Address} from 'viem';

const env = (key: string): Address =>
  (process.env[key] ?? '0x0000000000000000000000000000000000000000') as Address;

export const contracts = {
  rewardToken: env('NEXT_PUBLIC_REWARD_TOKEN_ADDRESS'),
  masterChef: env('NEXT_PUBLIC_MASTERCHEF_ADDRESS'),
  vault: env('NEXT_PUBLIC_VAULT_ADDRESS'),
  router: env('NEXT_PUBLIC_ROUTER_ADDRESS'),
} as const;

export const masterChefAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'pid', type: 'uint256'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'pid', type: 'uint256'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'harvest',
    stateMutability: 'nonpayable',
    inputs: [{name: 'pid', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'harvestMany',
    stateMutability: 'nonpayable',
    inputs: [{name: 'pids', type: 'uint256[]'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'emergencyWithdraw',
    stateMutability: 'nonpayable',
    inputs: [{name: 'pid', type: 'uint256'}],
    outputs: [],
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
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'assets', type: 'uint256'},
      {name: 'receiver', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'shares', type: 'uint256'},
      {name: 'receiver', type: 'address'},
      {name: 'owner', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
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
    name: 'callerBounty',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
] as const;

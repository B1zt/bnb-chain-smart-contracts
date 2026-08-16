import type {Address} from 'viem';

const env = (key: string): Address =>
  (process.env[key] ?? '0x0000000000000000000000000000000000000000') as Address;

export const contracts = {
  factory: env('NEXT_PUBLIC_FACTORY_ADDRESS'),
  locker: env('NEXT_PUBLIC_LOCKER_ADDRESS'),
  bridge: env('NEXT_PUBLIC_BRIDGE_ADDRESS'),
} as const;

/** Sentinel for native BNB in the presale's currency mappings. */
export const NATIVE = '0x0000000000000000000000000000000000000000' as const;

export const presaleAbi = [
  {
    type: 'function',
    name: 'contribute',
    stateMutability: 'payable',
    inputs: [
      {name: 'tierAllowanceUsd', type: 'uint256'},
      {name: 'proof', type: 'bytes32[]'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'contributeToken',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'currency', type: 'address'},
      {name: 'amount', type: 'uint256'},
      {name: 'tierAllowanceUsd', type: 'uint256'},
      {name: 'proof', type: 'bytes32[]'},
    ],
    outputs: [],
  },
  {type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {type: 'function', name: 'finalize', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
  {
    type: 'function',
    name: 'contributedUsd',
    stateMutability: 'view',
    inputs: [{name: 'contributor', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const bridgeAbi = [
  {
    type: 'function',
    name: 'bridgeOut',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'destinationChainId', type: 'uint256'},
      {name: 'recipient', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'remainingDailyLimit',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
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

/** Hand-maintained ABI fragments: only what the backend reads or indexes. */

export const factoryAbi = [
  {
    type: 'event',
    name: 'PresaleCreated',
    inputs: [
      {name: 'presale', type: 'address', indexed: true},
      {name: 'creator', type: 'address', indexed: true},
      {name: 'token', type: 'address', indexed: true},
      {name: 'tokensFunded', type: 'uint256', indexed: false},
      {name: 'index', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'PresaleVerified',
    inputs: [
      {name: 'presale', type: 'address', indexed: true},
      {name: 'verified', type: 'bool', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'presaleCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'presales',
    stateMutability: 'view',
    inputs: [{name: 'index', type: 'uint256'}],
    outputs: [{type: 'address'}],
  },
  {
    type: 'function',
    name: 'isVerified',
    stateMutability: 'view',
    inputs: [{name: 'presale', type: 'address'}],
    outputs: [{type: 'bool'}],
  },
] as const;

export const presaleAbi = [
  {
    type: 'event',
    name: 'Contributed',
    inputs: [
      {name: 'contributor', type: 'address', indexed: true},
      {name: 'currency', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'usdValue', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      {name: 'contributor', type: 'address', indexed: true},
      {name: 'tokenAmount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Refunded',
    inputs: [
      {name: 'contributor', type: 'address', indexed: true},
      {name: 'currency', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Finalised',
    inputs: [
      {name: 'raisedUsd', type: 'uint256', indexed: false},
      {name: 'tokensSold', type: 'uint256', indexed: false},
    ],
  },
  {type: 'event', name: 'Cancelled', inputs: []},
  {
    type: 'function',
    name: 'config',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {name: 'token', type: 'address'},
      {name: 'tokensPerUsd', type: 'uint256'},
      {name: 'softCapUsd', type: 'uint256'},
      {name: 'hardCapUsd', type: 'uint256'},
      {name: 'minContributionUsd', type: 'uint256'},
      {name: 'maxContributionUsd', type: 'uint256'},
      {name: 'startTime', type: 'uint64'},
      {name: 'endTime', type: 'uint64'},
      {name: 'tierRoot', type: 'bytes32'},
      {name: 'contributionCooldown', type: 'uint32'},
    ],
  },
  {type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
  {
    type: 'function',
    name: 'totalRaisedUsd',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'contributorCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'contributedUsd',
    stateMutability: 'view',
    inputs: [{name: 'contributor', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'tokensFor',
    stateMutability: 'view',
    inputs: [{name: 'contributor', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [{name: 'contributor', type: 'address'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'progressBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {type: 'function', name: 'finalised', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
] as const;

/** `Presale.Status`, in declaration order. */
export const PRESALE_STATUS = ['PENDING', 'LIVE', 'SUCCEEDED', 'FAILED', 'FINALISED'] as const;

export const lockerAbi = [
  {
    type: 'event',
    name: 'LockCreated',
    inputs: [
      {name: 'lockId', type: 'uint256', indexed: true},
      {name: 'token', type: 'address', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'unlockAt', type: 'uint64', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'LockExtended',
    inputs: [
      {name: 'lockId', type: 'uint256', indexed: true},
      {name: 'previousUnlock', type: 'uint64', indexed: false},
      {name: 'newUnlock', type: 'uint64', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      {name: 'lockId', type: 'uint256', indexed: true},
      {name: 'to', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'locks',
    stateMutability: 'view',
    inputs: [{name: 'lockId', type: 'uint256'}],
    outputs: [
      {
        type: 'tuple',
        components: [
          {name: 'token', type: 'address'},
          {name: 'owner', type: 'address'},
          {name: 'amount', type: 'uint256'},
          {name: 'lockedAt', type: 'uint64'},
          {name: 'unlockAt', type: 'uint64'},
          {name: 'withdrawn', type: 'bool'},
          {name: 'description', type: 'string'},
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'locksByToken',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [{type: 'uint256[]'}],
  },
  {
    type: 'function',
    name: 'lockedSupplyBps',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalLocked',
    stateMutability: 'view',
    inputs: [{name: 'token', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

const transferTuple = {
  type: 'tuple',
  components: [
    {name: 'sourceChainId', type: 'uint256'},
    {name: 'destinationChainId', type: 'uint256'},
    {name: 'destinationBridge', type: 'address'},
    {name: 'token', type: 'address'},
    {name: 'recipient', type: 'address'},
    {name: 'amount', type: 'uint256'},
    {name: 'nonce', type: 'uint256'},
  ],
} as const;

export const bridgeAbi = [
  {
    type: 'event',
    name: 'TransferInitiated',
    inputs: [
      {name: 'messageHash', type: 'bytes32', indexed: true},
      {name: 'sender', type: 'address', indexed: true},
      {name: 'token', type: 'address', indexed: true},
      {name: 'destinationChainId', type: 'uint256', indexed: false},
      {name: 'recipient', type: 'address', indexed: false},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'nonce', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'TransferCompleted',
    inputs: [
      {name: 'messageHash', type: 'bytes32', indexed: true},
      {name: 'token', type: 'address', indexed: true},
      {name: 'recipient', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'TransferQueued',
    inputs: [
      {name: 'messageHash', type: 'bytes32', indexed: true},
      {name: 'executableAt', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'bridgeIn',
    stateMutability: 'nonpayable',
    inputs: [
      {...transferTuple, name: 'transfer'},
      {name: 'signatures', type: 'bytes[]'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeQueued',
    stateMutability: 'nonpayable',
    inputs: [
      {...transferTuple, name: 'transfer'},
      {name: 'signatures', type: 'bytes[]'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferDigest',
    stateMutability: 'view',
    inputs: [{...transferTuple, name: 'transfer'}],
    outputs: [{type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'transferHash',
    stateMutability: 'pure',
    inputs: [{...transferTuple, name: 'transfer'}],
    outputs: [{type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'processed',
    stateMutability: 'view',
    inputs: [{name: 'messageHash', type: 'bytes32'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'queuedAt',
    stateMutability: 'view',
    inputs: [{name: 'messageHash', type: 'bytes32'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'threshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
  {
    type: 'function',
    name: 'validators',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'address[]'}],
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
  {type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
  {type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
  {type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{type: 'uint8'}]},
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
] as const;

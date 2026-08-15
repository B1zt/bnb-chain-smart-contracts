# DeFi Farm and Auto-Compounding Vault

A yield farm for BNB Smart Chain: a capped BEP-20 reward token, a multi-pool MasterChef with
per-second emissions, an ERC-4626 vault that auto-compounds its rewards through PancakeSwap, and a
Chainlink oracle that refuses to serve a stale price.

Contracts in Solidity with Foundry. Backend in TypeScript with Fastify, Prisma and viem. Frontend in
Next.js with wagmi and RainbowKit.

> **BEP-20 is ERC-20.** There is no separate standard to implement. What makes this a BNB Chain
> project is the ecosystem it integrates with: PancakeSwap for liquidity, Chainlink's BSC feeds for
> pricing, and deployment targets across BSC mainnet, testnet and opBNB.

---

## What is actually interesting here

**The four MasterChef bugs, actually fixed.** Most BSC farms are copies of a copy, and they inherit
the same defects:

1. `add` calls `massUpdatePools` first. Changing allocation points without settling every pool
   retroactively rewrites how much each one earned since its last update. This is the single most
   common MasterChef bug, and `test_addingPoolDoesNotRetroactivelyChangeEarnings` pins the fix.
2. Deposits measure the balance actually received, not the amount requested. BNB Chain is full of
   fee-on-transfer tokens; assuming the requested amount means the pool credits more than it holds
   and the last withdrawer cannot exit.
3. Emissions are per second, not per block. BNB Chain's block time has changed more than once, and
   a per-block rate silently rewrites the emission schedule when it does.
4. `emergencyWithdraw` touches no reward accounting and calls nothing on the reward token, so it
   still works when the reward path is broken.
   `test_emergencyWithdraw_worksWhenRewardTokenIsBroken` disables minting entirely and asserts
   principal still comes out.

**The farm winds down instead of bricking.** Emissions are clamped to what the token will actually
let the farm mint. Without that clamp, `updatePool` reverts once the cap is reached, and since
deposit, withdraw and harvest all call it, the entire farm would freeze at the exact moment
emissions ended, stranding every staker's principal. This was caught by
`test_farmKeepsWorkingAfterCapIsReached` during development, not by inspection.

**Compounding is bounded against a same-transaction quote.** `compound` is public and moves a known
amount through a public AMM, which is a sandwich served on a plate. The minimum output is derived
from `getAmountsOut` in the same transaction, not from a stored price which would itself be
manipulable. The mock router can simulate a sandwich, so
`test_compound_revertsWhenSandwichedBeyondTolerance` proves the bound bites and
`test_compound_toleratesMovementWithinSlippageBound` proves it is not simply rejecting everything.

**Compounding is permissionless and pays a bounty.** A vault only its owner can compound stops
compounding the moment that keeper breaks, and rewards left unharvested for days cost far more than
any realistic sandwich.

**The oracle rejects stale prices.** A Chainlink feed that stops updating keeps returning its last
answer forever, with no error. Four checks stand between a feed and a price: positive answer, fresh
`updatedAt`, complete round, and `answeredInRound >= roundId`. Callers choose `getPrice`, which
reverts, or `tryGetPrice`, which degrades, because a liquidation must revert while a dashboard
should not.

**Fork tests run against live BSC.** Mocks prove the logic is self-consistent; they cannot prove the
integration is right, because a mock is written to the same assumptions as the contract it tests.
The fork suite hits the real PancakeSwap router, the real WBNB/BUSD pair and the real Chainlink
BNB/USD feed, and cross-checks the oracle against the AMM. **It caught a wrong WBNB constant during
development** that every mock test had happily passed.

---

## Layout

```
contracts/
  src/
    RewardToken.sol         Capped BEP-20, role-gated mint, one-way finishMinting
    MasterChef.sol          Multi-pool farm, per-second emissions, deposit fees, harvest lockups
    AutoCompoundVault.sol   ERC-4626 vault: harvest, swap, add liquidity, restake
    PriceOracle.sol         Chainlink feeds with staleness and round-completeness checks
    interfaces/             IRewardToken, IMasterChef, IPancakeRouter, IPancakePair
  test/                     73 tests, plus 7 fork tests against live BSC
  script/Deploy.s.sol       Chain-aware: picks the right router and feed for BSC, testnet or opBNB

backend/            Pool stats, APR calculation, TVL indexer, keeper bot
frontend/           Farm grid, stake/unstake/harvest, vault position, compound button
```

---

## Running it

```bash
docker compose up -d                         # Postgres + a local BSC-like node

cd contracts
forge install
forge test                                   # 73 tests
forge lint src                               # clean

# Fork tests need an RPC. They skip automatically without one.
BSC_RPC_URL=https://bsc-dataseed.binance.org forge test --match-contract ForkPancakeTest

# Deploy to BSC testnet
PRIVATE_KEY=0x... LP_TOKEN=0x... forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --verify

cd ../backend  && cp .env.example .env && pnpm install && pnpm db:migrate && pnpm dev
cd ../frontend && cp .env.example .env.local && pnpm install && pnpm dev
```

The deploy script picks the correct PancakeSwap router and Chainlink feed from the chain id, so the
same command works on mainnet, testnet and opBNB without editing addresses.

---

## Tests

```bash
forge test                        # 73 tests
forge test --gas-report
forge coverage --ir-minimum
FOUNDRY_PROFILE=deep forge test   # 10,000 fuzz runs

BSC_RPC_URL=... forge test --match-contract ForkPancakeTest   # 7 tests against live BSC
```

Properties worth calling out:

- `testFuzz_emissionsAreBounded` - total rewards across all users never exceed the emission schedule
- `testFuzz_principalIsAlwaysRecoverable` - whatever happens, a staker can retrieve their principal
- `testFuzz_vaultStaysSolvent` - shares outstanding are always redeemable from assets under management
- `testFuzz_roundTripNeverProfits` - deposit then immediately redeem can never return more than went in
- `testFuzz_stalenessBoundaryIsExact` - the oracle accepts a price exactly when it is inside the window
- `testFuzz_normalisationIsExact` - decimal normalisation is exact for any answer a feed can report

---

## Security notes

| Decision | Reason |
|---|---|
| Reward token cap is `immutable` | Unlimited minting is the standard shape of a farm rug |
| Minting is a role, granted to the chef | The farm can pay emissions without holding every other admin power |
| `finishMinting` is one-way | Stronger than revoking a role, which can be granted again |
| Emissions clamped to what is mintable | Otherwise the farm bricks the moment the cap is reached |
| `add` and `set` call `massUpdatePools` | Otherwise allocation changes apply retroactively |
| Deposits measure received balance | Fee-on-transfer tokens would otherwise break pool accounting |
| `lpSupply` tracked, not `balanceOf` | A direct transfer into the farm cannot distort reward maths |
| Deposit fee capped at 4% | Admin error cannot turn a fee into confiscation |
| Harvest lockup capped at 14 days | An owner cannot lock rewards away indefinitely |
| Emission rate capped | Bounds a fat-fingered update |
| Reward token cannot be farmed | Otherwise the pool mints into its own staked balance |
| `emergencyWithdraw` avoids reward logic | Principal must be recoverable even when rewards are broken |
| Compound slippage bounded by a live quote | A stored price is manipulable; a stale one protects nothing |
| Slippage cap is itself capped at 3% | Admin error cannot widen it into meaninglessness |
| Caller bounty on compound | Keeps compounding frequent without a trusted keeper |
| Vault withdrawals are never pausable | A pause must not trap user funds |
| `_decimalsOffset` of 6 | Makes the ERC-4626 inflation attack cost far more than it returns |
| Oracle checks four conditions per read | A stale feed returns its last answer forever, with no error |
| Oracle heartbeat capped at 2 days | A feed allowed to be a week stale is not an oracle |

Every privileged function is `onlyOwner`, and **the owner should be a multisig in production**. The
deploy script accepts an `OWNER` env var and prints a warning when the owner is still the deployer.

This code has not been audited. It is a reference implementation.

---

## License

MIT

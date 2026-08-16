# Launchpad, Presale and Cross-Chain Bridge

A token launchpad for BNB Chain: presales with unconditional refunds, a liquidity locker with no
escape hatch, Chainlink-priced contributions, and a lock-and-mint bridge with a threshold validator
set.

Contracts in Solidity with Foundry. Backend in TypeScript with Fastify, Prisma and viem, including
the bridge relayer. Frontend in Next.js with wagmi and RainbowKit.

---

## A note on this category

Presales and bridges are the two most abused contract types in crypto. Presales because the money
arrives before the product, bridges because they concentrate value behind code that has repeatedly
turned out to be wrong.

Both are built here around one principle: **a buyer should be able to verify the guarantees, not
trust them.** Every safety property below is enforced by code and covered by a test, and where a
guarantee genuinely cannot be given, the README and the UI say so rather than implying otherwise.

---

## What is actually interesting here

### Presale

**Refunds are unconditional and permissionless.** Below the soft cap, every contributor can withdraw
in full. No owner action is required and no owner action can prevent it, because `status()` is a
pure function of the raise, the clock and the cancellation flag. `finalize` is the only path from
escrow to the project and it reverts below the soft cap.

**The absence of functions is the feature.** There is no `emergencyWithdraw`, no `rescueTokens`
covering the raise currency, and no admin path to escrowed funds. Those functions are how presale
rugs are actually executed, and `test_ownerCannotTouchFundsBeforeFinalisation` asserts they are not
reachable.

**Terms are immutable once set.** Caps, price and timing are fixed at initialisation. A presale
whose price the owner can change after you have paid is not a presale.

**Contributions are priced in USD via Chainlink.** A BNB contribution and a stablecoin contribution
count identically against the caps. Pricing a raise in BNB means the real cap moves with the market
between opening and closing.

**Sales are funded atomically with creation.** The factory pulls the full token allocation in the
same transaction that deploys the clone. A listed sale that cannot honour a single claim is the
classic launchpad failure.

**Clones, not deployments.** A full presale costs a few million gas; an EIP-1167 minimal proxy costs
about 45,000. The implementation is `_disableInitializers()`-locked, so the template itself cannot
be hijacked.

### Liquidity locker

**No early withdrawal, for anyone, ever.** No owner, no admin role, no emergency function. A locker
with an escape hatch provides no assurance at all, because the escape hatch is what gets used during
a rug. Locks can be extended, transferred and split, but never shortened.

**Amounts are measured, not assumed.** A fee-on-transfer token delivers less than was sent, and a
locker reporting more than it holds is worse than no locker.

**`lockedSupplyBps` is the number that matters.** "5% locked" and "95% locked" are very different
situations, and a raw amount does not distinguish them.

### Bridge

**Written around the exploits that have actually happened.** Each defence maps to a specific
incident, and each has a test named after the failure class:

| Failure | Incident | Defence here |
|---|---|---|
| Message replay | Nomad, $190M | `processed` checked before any state change, zero hash rejected |
| Signature verification bypass | Wormhole, $325M | EIP-712 digest binds chain id, bridge address and every field |
| Cross-chain signature reuse | general | `destinationChainId` and `destinationBridge` both checked |
| Duplicate validator signatures | deployed multisig bridges | Signers must be strictly ascending |
| Compromised validator majority | Ronin, $625M | Strict-majority threshold, daily caps, large-transfer delay |

**The relayer is not trusted.** It cannot forge a transfer, change an amount or redirect a
recipient: all of it is covered by validator signatures and re-derived on the destination. The worst
it can do is refuse to relay, and anyone can run another.

**The relayer's own hard problem is crash safety**, not security. Every transfer has a persisted
lifecycle (`OBSERVED → CONFIRMED → SIGNED → SUBMITTED → COMPLETED`) with each transition written
before the action it authorises, so a restart resumes rather than dropping or duplicating.

**What this bridge does not give you.** It is externally validated, so its security rests on a
majority of validators being honest and independently operated. That assumption has failed on
bridges far larger than this one. For production, a battle-tested messaging layer such as LayerZero,
Axelar or Chainlink CCIP moves that problem to a party that specialises in it. The UI says this in
as many words, above the send button.

---

## Layout

```
contracts/
  src/
    Presale.sol             Soft/hard caps, tiers, USD pricing, unconditional refunds
    PresaleFactory.sol      EIP-1167 clone factory, funds each sale atomically
    LiquidityLocker.sol     Time locks with no early withdrawal, splittable and extendable
    ChainlinkPriceFeed.sol  USD pricing with staleness and round-completeness checks
    TokenBridge.sol         Lock-and-mint with a threshold validator set
    BridgedToken.sol        Bridge-only mint, so supply is always backed
  test/                     70 tests, organised by exploit class for the bridge
  script/Deploy.s.sol       Chain-aware; mainnet constants verified against the live chain

backend/            Launchpad indexer, tier Merkle service, bridge relayer
frontend/           Sale browser, contribute/claim/refund, lock explorer, bridge UI
```

---

## Running it

```bash
docker compose up -d                         # Postgres

cd contracts
forge install
forge test                                   # 70 tests
forge lint src                               # clean

PRIVATE_KEY=0x... BRIDGE_VALIDATORS=0xa,0xb,0xc \
  forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --verify

cd ../backend  && cp .env.example .env && pnpm install && pnpm db:migrate && pnpm dev
cd ../frontend && cp .env.example .env.local && pnpm install && pnpm dev
```

The bridge needs deploying on **both** chains, then `configureChain` called on each pointing at the
other. That step cannot be scripted from one side, because neither address exists until the other is
live.

To run the relayer end to end locally, set `DEV_VALIDATOR_KEYS` to a few private keys. That mode
signs locally instead of calling validator services, and refuses to run outside
`NODE_ENV=development`, because one process holding every validator key is a custodian rather than a
bridge.

---

## Tests

```bash
forge test                        # 70 tests
forge test --gas-report
forge coverage --ir-minimum
FOUNDRY_PROFILE=deep forge test   # 10,000 fuzz runs
```

Properties worth calling out:

- `testFuzz_failedSaleRefundsEverything` - a failed sale returns every wei it took, nothing stranded
- `testFuzz_hardCapIsNeverExceeded` - the raise cannot exceed the cap however contributions arrive
- `testFuzz_noTransferIsEverReleasedTwice` - no amount or nonce allows a double release
- `testFuzz_belowThresholdAlwaysRejected` - any signature count below threshold is rejected
- `testFuzz_neverWithdrawableEarly` - no lock is ever withdrawable before its unlock time
- `testFuzz_splitConservesTotal` - splitting a lock creates and destroys nothing

---

## Security notes

| Decision | Reason |
|---|---|
| No admin path to escrowed funds | This is how presale rugs are executed |
| `status()` is a pure function of raise and clock | Nobody can flip a failed sale into a successful one |
| Sale terms immutable after initialisation | A price the owner can change after you pay is not a price |
| Refunds return every currency used | A partial refund is not a refund |
| Sales funded atomically at creation | A listed sale must be able to honour its claims |
| `finalize` checks token balance first | The project cannot take the money and leave buyers unable to claim |
| Implementation is `_disableInitializers()` | Otherwise the template is a live unowned contract |
| Contributions measured, not assumed | Fee-on-transfer tokens would leave the last refund short |
| Locker has no owner at all | An escape hatch is what gets used during a rug |
| Locks can be extended, never shortened | Otherwise "extend" becomes the escape hatch |
| Lock duration capped at 10 years | A century-long lock is a burn; burning is the honest way to do that |
| Price feed has no `tryGetPrice` | If the price cannot be trusted, the contribution must not be accepted |
| Bridge signatures bind chain id and address | Stops replay across chains and deployments |
| Signers must be strictly ascending | Makes duplicate-signature threshold bypass impossible |
| Threshold enforced as a strict majority | A minority moving funds defeats the point of a validator set |
| Daily caps per token | Bounds what a compromised validator set can extract |
| Large transfers delayed one hour | Creates a window in which pausing actually helps |
| Pause is not behind a timelock | When a bridge is being drained, a two day delay on stop is useless |
| `BridgedToken` mint is bridge-only | Every unit must correspond to a locked unit on the home chain |

Every privileged function is `onlyOwner`, and **the owner should be a multisig in production**.

**This code has not been audited. Do not bridge real value with it.** It is a reference
implementation published to show how these systems are built and where they go wrong.

---

## License

MIT

# example — delegation pattern on dpm sandbox

A runnable example showing the [**delegation pattern**](https://docs.digitalasset.com/build/3.5/sdlc-howtos/smart-contracts/develop/patterns/delegation.html) — one party (the *attorney*) exercises a choice on behalf of another (the *principal*) via a power-of-attorney contract.

Designed to pair with **cnwla**: after `make up`, three CLI profiles (`issuer`, `alice`, `bob`) work out of the box against a pre-populated sandbox.

---

## What it sets up

```
parties:  issuer, alice (principal), bob (attorney)
users:    issuer, alice, bob  (each with CanActAs over their own party)
contracts:
  • Coin       owner=alice,  issuer=issuer,  amount=100, delegates=[bob]
  • CoinPoA    principal=alice, attorney=bob
```

## Templates

- **`Coin`** — issued by `issuer` to `owner`; carries a list of `delegates` who can see it (observers).
- **`TransferProposal`** — intermediate contract produced by `Coin.Transfer`; the proposed `newOwner` decides to `Accept` or `Reject`.
- **`CoinPoA`** — power of attorney. `principal` grants `attorney` the right to invoke `TransferCoin` on any `Coin` the principal owns.

The key move: **the attorney controls `CoinPoA.TransferCoin`**, which internally exercises `Coin.Transfer` — a choice controlled by the `owner` (the principal). That delegates the owner's authority to the attorney for a specific operation, without transferring ownership.

---

## Prerequisites

- `dpm` installed (`curl https://get.digitalasset.com/install/install.sh | sh`, then `export PATH=$HOME/.dpm/bin:$PATH`)
- `cnwla` built and linked (`cd .. && npm run build && npm link`)
- No other Canton sandbox running on ports `6864–6866`

## Quickstart

```bash
make up
```

That runs, in order:
1. `dpm build` — compiles `daml/*.daml` into `.daml/dist/example-0.0.1.dar`
2. Starts `dpm sandbox --dar ...` in the background (logs in `sandbox.log`)
3. Waits for the JSON API to respond on `:6864`
4. Runs `dpm script --script-name Setup:setup` to allocate parties, create users, and seed the Coin + CoinPoA

When it's done you'll see:
```
  → ready. sandbox:  http://127.0.0.1:6864
  → try:             cnwla --profile alice whoami
```

### Profiles

Four profiles — `sandbox`, `issuer`, `alice`, `bob` — are in [`cnwla.config.yaml`](./cnwla.config.yaml). **The CLI auto-discovers this file** when run from anywhere under `example/`:

```bash
cd example
cnwla whoami              # → alice (currentProfile from ./cnwla.config.yaml)
```

**Config precedence** (highest wins):
1. `--config <path>` flag
2. `CANTON_CONFIG` env var
3. `cnwla.config.yaml` in CWD or any parent directory
4. `~/.cnwla/config.yaml`

So this example's config applies inside `example/` but doesn't pollute your global config. `cd` out of the tree and the CLI goes back to whatever you had in `~/.cnwla/config.yaml`.

---

## CLI walkthrough

```bash
# Who am I?
cnwla --profile alice whoami
# → alice, primaryParty=alice::1220..., CanActAs=[alice::...]

# Bob sees the Coin because he's a delegate (observer) on it.
cnwla --profile bob whoami --format party

# (Once `cnwla query` lands) see all Coins alice owns:
cnwla --profile alice query --template :Delegation:Coin

# (Once `cnwla exercise` lands) bob transfers alice's coin via the PoA:
cnwla --profile bob exercise $POA_CID TransferCoin \
  --arg '{"coinId":"'$COIN_CID'","newOwner":"charlie::..."}'
```

Today only `cnwla whoami` ships; each later command becomes a new demo against this same fixture.

---

## Make targets

| Target | Does |
|---|---|
| `make up` | build + start sandbox + wait + run Setup script |
| `make down` | kill the background sandbox (reads `sandbox.pid`) |
| `make reset` | `down` followed by `up` (fresh ledger state) |
| `make build` | just `dpm build` |
| `make init` | just run Setup script (assumes sandbox running) |
| `make clean` | delete `.daml/`, `sandbox.log`, `sandbox.pid` |

## Troubleshooting

- **Port in use** — another Canton sandbox is running. `make down` in this dir, or kill whatever's on `6864–6866` (`lsof -i :6864`).
- **`cnwla: fetch failed`** — sandbox listens on IPv4 only; make sure CLI profiles use `http://127.0.0.1:6864`, not `localhost:6864`.
- **`env var ... referenced in config but not set`** — the `auth:` block in the profile probably has `token:` but no value. For sandbox, drop the `token` line entirely (it's an unauthenticated ledger).
- **`dpm build` fails with "sdk-version not found"** — `dpm install 3.4.11` first.

## Layout

```
example/
├── daml.yaml              # sdk-version, deps
├── daml/
│   ├── Delegation.daml    # Coin, TransferProposal, CoinPoA
│   └── Setup.daml         # allocateParty + createUser + seed contracts
├── Makefile               # up / down / reset / build / init / clean
├── cnwla.config.yaml     # CLI profiles for sandbox / issuer / alice / bob
└── README.md              # you are here
```

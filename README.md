# cnwla

**Canton Network Wrapped LedgerAPI** — a CLI for
Canton Network ledgers. Wraps the HTTP **JSON Ledger API v2** with
ergonomic commands.
´
---

## Install

### From source (current only path until v0.1 ships)

```bash
git clone https://github.com/Nunobrazz/cnwla.git
cd cnwla
npm install
npm run build
npm link           
```

Requirements: **Node 18+**, a Canton participant speaking JSON Ledger API v2.

---

## quickstart

Run the bundled [`example/`](./example) — a delegation-pattern demo on `dpm sandbox`:

```bash
cd example
make up                       # build + start sandbox + seed parties/users/contracts
cnwla whoami            # → alice (from example/cnwla.config.yaml, auto-discovered)
cnwla --profile bob whoami   # → bob
cnwla config list            # lists all profiles
make down                     # when you're done
```

Under the hood: `make up` compiles the Daml, starts `dpm sandbox` with the
DAR pre-loaded, waits for the synchronizer, runs a Daml Script that
allocates three parties (`issuer`, `alice`, `bob`), creates users, and
seeds a `Coin` + `CoinPoA`. See [example/README.md](./example/README.md).

---

## Command map

| Command | Status | What it does |
|---|---|---|
| `cnwla whoami` | ✅ | Prints profile, participant, userId, primary party, rights |
| `cnwla config show` | ✅ | Active config file path + selected profile |
| `cnwla config list` | ✅ | List profiles; `*` marks `currentProfile` |
| `cnwla config use <name>` | ✅ | Persist `currentProfile` to the active config file |
| `cnwla init [url]` | ❌ | Bootstrap the config: auto-generate one profile per user on a participant |
| `cnwla parties ls` | ✅ | List allocated parties on the participant |
| `cnwla query` | ✅ | Active-contracts search scoped to the profile's primary party; `--template` / `--where` / `--pick` / `--one` / `--count` / `--full` |
| `cnwla create <template>` | ✅ | Submit a `CreateCommand`; positional `k=v` args or `--arg`, `--act-as`, `--pick`, `--full` |
| `cnwla exercise <cid> <choice>` | ✅ | Submit an `ExerciseCommand`; auto-resolves templateId from cid, `--tree` for causal view, three-bucket default output |

Run `cnwla <command> --help` for flags.

---

## Configuration

A **profile** bundles *"who am I, where am I talking"* — one named block
of YAML per identity:

```yaml
profiles:
  alice:
    participant: http://127.0.0.1:6864
    auth:
      mode: shared-secret       # or: oauth2
      token: ${env:MY_TOKEN}    # optional env interpolation
    userId: alice
```

The CLI **auto-discovers `cnwla.config.yaml`** walking up from the
current directory, falling back to `~/.cnwla/config.yaml`. So each
project can carry its own config without polluting your global one.

Full schema, precedence rules, and auth modes: [docs/configuration.md](./docs/configuration.md).

---

## Why

Hand-written scripts against Canton's JSON API collapse into multi-line
curl+jq pipelines that branch on `AUTH_MODE`, build 10-field submit
bodies from heredocs, and extract contract IDs with ad-hoc `jq
'..|objects|select(...)'` expressions. One demo script in the Canton
quickstart is [170 lines](https://github.com/digital-asset/cn-quickstart/blob/main/quickstart/docker/auction-bid/run.sh)
for what should be two commands.

---

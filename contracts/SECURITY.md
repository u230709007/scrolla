# Security review

Internal review of `src/AlphaScrollSessionVault.sol` and the testnet-only `src/testnet/AlphaTestDex.sol`, done on 2026-10-24.

**This is not a professional audit.** It is a manual line-by-line review, a Slither 0.11.6 static analysis run, and 11 tests (`npm test`). Get an independent audit before the vault holds meaningful value on mainnet.

## Summary

No critical or high-severity issues were found. The main risk is the one the design accepts: a leaked session key can make bad trades with the remaining session budget. It can never withdraw.

| ID | Severity | Contract | Finding | Status |
|---|---|---|---|---|
| V-1 | Medium (by design) | Vault | A leaked session key can waste the remaining budget | Accepted, bounded by caps |
| V-2 | Low | Vault | `authorizeSession` can be front-run to grief with `KeyInUse` | Accepted |
| V-3 | Low | Vault | An address registered as someone else's session key cannot `buy` for itself | Accepted |
| V-4 | Info | Vault | `Bought.amountOut` comes from the token's own `balanceOf` | Accepted |
| V-5 | Info | Vault | The router is trusted and immutable | Accepted |
| R-1 | Info | AlphaTestRouter | The owner can remove liquidity at any time | Testnet only |
| W-1 | Medium | Web app | The session key's private key lives in `localStorage` | Accepted, bounded by caps |

## Findings

### V-1: a leaked session key can waste the remaining budget

`buy(token, amountIn, amountOutMin, deadline)` takes `token` and `amountOutMin` from the session key. Someone holding a leaked key can:

- set `amountOutMin = 0` and sandwich their own trades, or
- buy a token whose pool they control on a permissionless V2 router, moving the budget into that pool.

The loss is capped by `maxPerTrade`, `remaining` and `expiry`, and bought tokens always go to the owner. On testnet, `AlphaTestRouter` only has pools the deployer created, so the second attack does not apply there.

Mitigation: keep budgets small and expiries short (the app defaults to 24 h). A per-session token allowlist would remove the second attack if the vault is used on mainnet.

### V-2: `authorizeSession` front-running

An attacker who sees a pending `authorizeSession(key, …)` can register the same `key` for themselves first. The victim's transaction then reverts with `KeyInUse`. No funds move; the app retries with a fresh key. Requiring a signature from the key over `(owner, vault, chainId)` would close this.

### V-3: session-key addresses cannot trade directly

`buy` looks up `ownerOfKey[msg.sender]` first. If Alice registers Bob's address as her session key, Bob's direct `buy` calls spend Alice's session (within her caps, tokens to Alice) instead of Bob's own deposit. Bob's funds are not at risk, and the app never calls `buy` directly from an owner.

### V-4: `amountOut` is self-reported by the token

The vault measures `amountOut` as the change in `token.balanceOf(owner)`. A malicious token can report any number. This only affects the `Bought` event and the trade history the web app stores; balances and caps do not depend on it.

### V-5: trusted router

The router is set once in the constructor. A malicious router could keep the MON sent to it. Deploy only against a known router (`setup:testnet` deploys and uses its own).

### R-1: testnet router liquidity is owner-controlled

`AlphaTestRouter` has no LP shares; only the deployer can add or remove liquidity, so they can empty a pool at any time. It is a testnet fixture and must not be used on mainnet.

### W-1: session key in browser storage

The web app keeps the session key in `localStorage`, so an XSS bug would expose it. The impact is the same as V-1. Revoking the session from the Trade tab invalidates the key on-chain and returns its unused gas to the owner.

## Slither results

Run with `--exclude-informational --exclude-optimization`:

| Detector | Location | Assessment |
|---|---|---|
| `arbitrary-send-eth` | `Vault._send` | False positive: sends only to `msg.sender` (withdraw) or the owner-chosen session key (gas stipend) |
| `timestamp` | `Vault.authorizeSession`, `Vault.buy` | Acceptable: expiries are hours long, so a few seconds of drift don't matter |
| `reentrancy-balance`, `reentrancy-no-eth`, `reentrancy-benign` | `AlphaTestRouter` swaps and `addLiquidity` | Guarded: every state-changing function is `nonReentrant`, and only owner-listed tokens have pools |
| `incorrect-equality` | `AlphaTestRouter._safeTransfer` | False positive: the standard `data.length == 0` check for tokens that return nothing |
| `missing-zero-check` | `AlphaTestRouter` constructor | Fixed |

## Checked and fine

- Reentrancy: `withdraw`, `authorizeSession` and `buy` are `nonReentrant`, and state is updated before external calls.
- A session key cannot withdraw: `withdraw` only touches `balanceOf[msg.sender]`, and the key's own balance is zero.
- Caps: `amountIn <= maxPerTrade` and `amountIn <= remaining` are checked before `remaining` is reduced, and the `uint128` cast is safe because `amountIn <= remaining`.
- Revocation: `_revoke` clears both `sessions[owner]` and `ownerOfKey[key]`. A revoked key falls back to "owner trading directly" with a zero balance, so `buy` reverts.
- Expiry: `authorizeSession` rejects past expiries, and `buy` rejects calls after expiry.
- Server-side trade records: `/api/trades` reads the receipt from the RPC and only accepts a `Bought` event from the configured vault for the signed-in owner.

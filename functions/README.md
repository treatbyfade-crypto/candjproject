# Chess and Whot Cloud Functions

Chess and Whot wagers are debited, matched, validated, and settled by callable Firebase Functions. Both games have a N3,000 minimum and no configured maximum; a player cannot stake more than their available wallet balance. Players choose 1, 3, 5, or 10 minutes after staking: Chess applies this as each player's match clock and awards a timeout win to the opponent; Whot applies it per turn and passes the turn without drawing when time expires. Human matchmaking requires matching stakes and time controls. Whot uses a two-player Nigerian 54-card deck and six-card opening hands.

The function source targets Firebase project `candjproject-1485c` and Node.js 22. Deployment is gated on completing and verifying the Firestore security migration below; do not run the deployment command yet. After that gate is cleared and live wagering is approved, deploy with:

```powershell
firebase deploy --only functions
```

The Firebase project must have Cloud Functions enabled on a billing plan that supports deployment. The app expects the functions in `us-central1`. Do not expose the `chessMatches`, `chessQueue`, `chessPlayers`, `whotMatches`, `whotQueue`, or `whotPlayers` collections to client writes in Firestore rules; all game state changes must go through these callable functions.

Before accepting wagers, verify that client Firestore rules deny reads and writes to those game collections and prevent clients from directly changing `users/{uid}.balance` or forging `transactions`. A deny rule does not override a broader matching allow rule, so review every rule that applies to those paths and merge changes into the existing rules without replacing the app's unrelated rules.

The chess bot uses Stockfish.js in its server-side WASM build at maximum skill, with a five-second search and a 64 MB hash. Human matches use the same `chess.js` rules engine for legal-move and draw validation. Whot uses the shared Nigerian rules implementation in `whot-logic.js` for both human and bot turns.

The production Firestore rules supplied during this task grant signed-in clients broad writes, including a catch-all for every collection. A restrictive draft now exists at the repository root in `firestore.rules`, and `firebase.json` points to it. Do not deploy that draft yet: several remaining wallet and game flows in `index.html` still write balances directly and must be migrated first. Deploying the draft before that migration would break those flows. Verify the effective rules before enabling wagers.

## Wallet transfer migration

Wallet transfers now run through the `walletTransfer` callable. The server validates the sender, recipient, membership, account restrictions, balance, and Transfer PIN, then atomically writes both balances, ledger entries, notifications, and an idempotency receipt. Transfer PIN hashes are stored in the server-only `transferPins` collection; legacy profile hashes are migrated after a successful PIN check. Five failed PIN checks within 15 minutes temporarily lock further attempts. Administrator wallet and Lagos Life adjustments run through `adminAdjustWallet`. Daily earning and check-in credits are also validated and committed by the `claimDailyEarning` and `claimDailyCheckin` callables.

`walletSetTransferPin` stores or replaces the caller's PIN on the server. Keep client writes to `users` balance fields, `transactions`, `walletTransfers`, `transferPins`, `transferPinAttempts`, and `adminWalletAdjustments` denied in Firestore rules. This is an incremental migration: remaining direct client balance mutations in `index.html` must also be moved before deploying restrictive rules or enabling real wagers.

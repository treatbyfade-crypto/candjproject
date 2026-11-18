# Chess and Whot Cloud Functions

Chess and Whot wagers are debited, matched, validated, and settled by callable Firebase Functions. Both games have a N3,000 minimum and no configured maximum; a player cannot stake more than their available wallet balance. Players choose 1, 3, 5, or 10 minutes after staking: Chess applies this as each player's match clock and awards a timeout win to the opponent; Whot applies it per turn and passes the turn without drawing when time expires. Human matchmaking requires matching stakes and time controls. Whot uses a two-player Nigerian 54-card deck and six-card opening hands.

The function source targets Firebase project `candjproject-1485c` and Node.js 20. After installing the Firebase CLI and signing in locally, deploy with:

```powershell
firebase deploy --only functions
```

The Firebase project must have Cloud Functions enabled on a billing plan that supports deployment. The app expects the functions in `us-central1`. Do not expose the `chessMatches`, `chessQueue`, `chessPlayers`, `whotMatches`, `whotQueue`, or `whotPlayers` collections to client writes in Firestore rules; all game state changes must go through these callable functions.

Before accepting wagers, verify that client Firestore rules deny reads and writes to those game collections and prevent clients from directly changing `users/{uid}.balance` or forging `transactions`. A deny rule does not override a broader matching allow rule, so review every rule that applies to those paths and merge changes into the existing rules without replacing the app's unrelated rules.

The chess bot uses Stockfish.js in its server-side WASM build at maximum skill, with a five-second search and a 64 MB hash. Human matches use the same `chess.js` rules engine for legal-move and draw validation. Whot uses the shared Nigerian rules implementation in `whot-logic.js` for both human and bot turns.

The Firestore rules supplied during this task grant signed-in clients broad writes, including a catch-all for every collection. Do not deploy wagering functions with those rules: harden the wallet and collection write paths first, then verify the effective rules before accepting wagers.

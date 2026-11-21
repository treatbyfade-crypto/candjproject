# Supabase backend migration

The existing app uses Firebase Authentication and Firestore. The `cj-backend` Edge Function verifies Firebase ID tokens and uses a server-only Firebase service account for Firestore access, so the app can keep its current users and data without deploying Firebase Functions.

The function currently implements:

- Transfer PIN setup and wallet transfers
- Administrator wallet/Lagos Life adjustments
- Daily earning and check-in claims
- Human Chess matchmaking, moves, resignations, and timeout settlement
- Whot bot and human matches, moves, resignations, and lazy timeout handling

The browser sends the Firebase ID token to this function. `FIREBASE_SERVICE_ACCOUNT` must be configured as a Supabase Edge Function secret; never put the service-account JSON in the repository or browser code. `FIREBASE_PROJECT_ID` defaults to `candjproject-1485c`.

Chess bot games are disabled: the existing Stockfish Node package crashes under Deno. A request to start a Chess bot match fails before any stake is deducted. Do not advertise Stockfish play until a Deno-compatible engine is implemented and verified.

## Current status

`cj-backend` is deployed and active in Supabase project `lcleywliqmyveoqnllgu`. A live unauthenticated request reached the Edge Function and returned the expected `401` response requiring a Firebase sign-in token. This confirms the deployed handler and authentication gate respond; it does not verify authenticated Firestore access, matchmaking, game settlement, or wallet payouts.

The Supabase Edge Function type-check and local Chess/Whot logic checks pass. The current Stockfish package crashes under Deno, so Chess-vs-bot is not available. Do not treat Chess-vs-bot, real-stake games, or production payouts as verified.

## Production readiness

Deployment is complete, but production game and wallet behavior is not yet verified. Do not use real wallet balances to smoke-test.

Before treating the games as ready for real stakes:

1. Verify authenticated requests can read and write the intended Firestore documents using a staging account or emulator, especially concurrent queue joins and payout settlement.
2. Review the effective production Firestore rules and all remaining client-side balance writes before accepting wagers.
3. Confirm the Supabase Firebase service-account secret is valid for `candjproject-1485c`; never expose its value.
4. Verify the Chess bot with an engine supported by Supabase Deno Edge before advertising Stockfish play.
5. Run the GitHub Actions JavaScript syntax and Deno type checks. These checks do not verify gameplay or wagering behavior.

The browser client routes migrated wallet/reward and Chess/Whot calls to `cj-backend`. Do not deploy the legacy Firebase Functions as a workaround without reviewing their Firestore security and client compatibility.

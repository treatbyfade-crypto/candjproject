import { Chess } from "npm:chess.js@1.4.0";
import {
  ApiError,
  getFirestoreDocument,
  newFirestoreDocumentId,
  runFirestoreTransaction,
} from "../_shared/firebase-rest.ts";
import type {
  FirebasePrincipal,
  FirestoreDocument,
  FirestoreQuery,
  FirestoreQueryDocument,
  FirestoreTransaction,
} from "../_shared/firebase-rest.ts";

type JsonRecord = Record<string, unknown>;
type Color = "w" | "b";
type GameResult = {
  draw: boolean;
  winnerColor: Color | null;
  winnerUid?: string | null;
  result: string;
};
type ChessGame = InstanceType<typeof Chess>;

const MIN_STAKE = 3000;
const TIME_OPTIONS_MINUTES = [1, 3, 5, 10];
const QUEUE_TTL_MS = 15 * 60 * 1000;
const PLAYER_CLOCK_MS = 10 * 60 * 1000;
const WHOT_SUITS = ["circle", "triangle", "cross", "square", "star"];
const WHOT_SUIT_VALUES: Record<string, number[]> = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8],
};
const WHOT_PENALTY_VALUES = [2, 5];
const WHOT_SPECIAL_VALUES = [1, 2, 5, 8, 14, 20];

function requireUid(principal: FirebasePrincipal): string {
  const uid = principal.uid;
  if (!uid) {
    throw new ApiError(401, "unauthenticated", "Sign in before playing chess.");
  }
  assertPathSegment(uid, "account");
  return uid;
}

function assertPathSegment(value: string, label: string): void {
  if (!value || value.length > 128 || value.includes("/")) {
    throw new ApiError(400, "invalid-argument", `Choose a valid ${label}.`);
  }
}

function parseMatchId(value: unknown, game: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ApiError(
      400,
      "invalid-argument",
      `A valid ${game} match ID is required.`,
    );
  }
  return value;
}

function parseStake(value: unknown, gameName: string): number {
  const stake = Number(value);
  if (
    !Number.isSafeInteger(stake) || stake < MIN_STAKE ||
    stake > Math.floor(Number.MAX_SAFE_INTEGER / 2)
  ) {
    throw new ApiError(
      400,
      "invalid-argument",
      `${gameName} stakes must be at least N3,000 and within the safe wallet calculation range.`,
    );
  }
  return stake;
}

function parseTimeMinutes(value: unknown, game: string): number {
  const minutes = Number(value);
  if (!TIME_OPTIONS_MINUTES.includes(minutes)) {
    throw new ApiError(
      400,
      "invalid-argument",
      `${game} time must be 1, 3, 5, or 10 minutes.`,
    );
  }
  return minutes;
}

function selectedClockMs(minutes: number): number {
  return minutes * 60 * 1000;
}

function whotTurnTimeMs(match: JsonRecord): number {
  const saved = Number(match.turnTimeMs);
  return Number.isSafeInteger(saved) && saved > 0
    ? saved
    : selectedClockMs(Number(match.timeMinutes) || 10);
}

function validateAccount(
  data: JsonRecord | null,
  stake: number,
  gameName: string,
): number {
  if (!data) {
    throw new ApiError(
      412,
      "failed-precondition",
      "Your account record could not be found.",
    );
  }
  if (["frozen", "disabled"].includes(String(data.accountStatus))) {
    throw new ApiError(
      403,
      "permission-denied",
      "Your account is restricted from playing.",
    );
  }
  const membership = data.membership as JsonRecord | undefined;
  if (membership?.active !== true) {
    throw new ApiError(
      412,
      "failed-precondition",
      `Your membership must be active before playing ${gameName.toLowerCase()}.`,
    );
  }
  const balance = Number(data.balance || 0);
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new ApiError(
      412,
      "failed-precondition",
      "Your wallet balance is invalid.",
    );
  }
  if (balance < stake) {
    throw new ApiError(
      412,
      "failed-precondition",
      "Your available wallet balance is too low for this stake.",
    );
  }
  return balance;
}

function accountIsAvailable(data: JsonRecord | null, stake: number): boolean {
  if (
    !data || ["frozen", "disabled"].includes(String(data.accountStatus)) ||
    (data.membership as JsonRecord | undefined)?.active !== true
  ) return false;
  const balance = Number(data.balance || 0);
  return Number.isSafeInteger(balance) && balance >= stake;
}

function accountName(data: JsonRecord, uid: string): string {
  return String(data.name || data.username || uid).slice(0, 80);
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value && typeof value === "object" && "toMillis" in value &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis(): number }).toMillis();
  }
  return null;
}

function isExpiredQueue(queue: JsonRecord, now = Date.now()): boolean {
  const createdAt = timestampMillis(queue.createdAt);
  return createdAt === null || now - createdAt > QUEUE_TTL_MS;
}

function ledgerData({
  uid,
  user,
  type,
  description,
  amount,
  stake,
  matchId,
  game = "chess",
}: {
  uid: string;
  user: JsonRecord;
  type: string;
  description: string;
  amount: number;
  stake: number;
  matchId: string;
  game?: string;
}): JsonRecord {
  return {
    userId: uid,
    userName: accountName(user, uid),
    userEmail: String(user.email || ""),
    type,
    description,
    amount,
    stake,
    game,
    roundId: matchId,
    date: new Date(),
    status: "completed",
  };
}

export function createChessGame(moves: JsonRecord[] = []): ChessGame {
  const game = new Chess();
  for (const move of moves) {
    const applied = game.move({
      from: move.from as string,
      to: move.to as string,
      ...(move.promotion ? { promotion: move.promotion as string } : {}),
    });
    if (!applied) {
      throw new Error("Stored chess history contains an illegal move.");
    }
  }
  return game;
}

export function applyChessMove(
  game: ChessGame,
  move: JsonRecord,
): ReturnType<ChessGame["move"]> {
  if (!move || typeof move.from !== "string" || typeof move.to !== "string") {
    throw new Error("Choose a valid chess move.");
  }
  const promotion = move.promotion
    ? String(move.promotion).toLowerCase()
    : undefined;
  if (promotion && !["q", "r", "b", "n"].includes(promotion)) {
    throw new Error("Choose a valid promotion piece.");
  }
  return game.move({
    from: move.from,
    to: move.to,
    ...(promotion ? { promotion } : {}),
  });
}

export function getChessOutcome(game: ChessGame): GameResult | null {
  if (!game.isGameOver()) return null;
  if (game.isCheckmate()) {
    return {
      draw: false,
      winnerColor: game.turn() === "w" ? "b" : "w",
      result: "Checkmate",
    };
  }
  if (game.isStalemate()) {
    return { draw: true, winnerColor: null, result: "Draw by stalemate" };
  }
  if (game.isThreefoldRepetition()) {
    return {
      draw: true,
      winnerColor: null,
      result: "Draw by threefold repetition",
    };
  }
  if (game.isInsufficientMaterial()) {
    return {
      draw: true,
      winnerColor: null,
      result: "Draw by insufficient material",
    };
  }
  if (game.isDraw()) {
    return {
      draw: true,
      winnerColor: null,
      result: "Draw by the 50-move rule",
    };
  }
  return { draw: true, winnerColor: null, result: "Draw" };
}

export function calculatePayouts(
  match: JsonRecord,
  result: GameResult,
  game: string,
): Record<string, number> {
  const stake = Number(match.stake);
  if (
    !Number.isSafeInteger(stake) || stake < 1 ||
    !Number.isSafeInteger(stake * 2)
  ) {
    throw new Error(`The ${game} stake cannot be safely settled.`);
  }
  if (result.draw) {
    const refunds: Record<string, number> = { [String(match.whiteUid)]: stake };
    if (match.mode !== "bot") refunds[String(match.blackUid)] = stake;
    return refunds;
  }
  if (match.mode === "bot") {
    if (!["w", "b"].includes(String(result.winnerColor))) {
      throw new Error(`The ${game} result has no winner.`);
    }
    return result.winnerColor === "w"
      ? { [String(match.whiteUid)]: stake * 2 }
      : { [String(match.whiteUid)]: 0 };
  }
  if (!result.winnerUid) throw new Error(`The ${game} result has no winner.`);
  return { [result.winnerUid]: stake * 2 };
}

function chessColorForUid(match: JsonRecord, uid: string): Color | null {
  if (match.whiteUid === uid) return "w";
  if (match.blackUid === uid) return "b";
  return null;
}

function whotColorForUid(match: JsonRecord, uid: string): Color | null {
  return chessColorForUid(match, uid);
}

function makeChessMatch({
  mode,
  stake,
  timeMinutes,
  whiteUid,
  blackUid,
  whiteName,
  blackName,
}: {
  mode: string;
  stake: number;
  timeMinutes: number;
  whiteUid: string;
  blackUid: string | null;
  whiteName: string;
  blackName: string;
}): JsonRecord {
  const game = new Chess();
  const now = Date.now();
  const playerClockMs = selectedClockMs(timeMinutes);
  return {
    mode,
    stake,
    timeMinutes,
    whiteUid,
    blackUid,
    whiteName,
    blackName,
    moves: [],
    fen: game.fen(),
    status: "active",
    clockMs: { w: playerClockMs, b: playerClockMs },
    turnStartedAt: now,
    turnDeadlineAt: now + playerClockMs,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildChessMatchView(match: JsonRecord, uid: string): JsonRecord {
  const playerColor = chessColorForUid(match, uid);
  if (!playerColor) {
    throw new ApiError(
      403,
      "permission-denied",
      "You are not a player in this chess match.",
    );
  }
  const game = createChessGame((match.moves || []) as JsonRecord[]);
  return {
    id: match.id,
    mode: match.mode,
    stake: match.stake,
    timeMinutes: Number(match.timeMinutes) || 10,
    status: match.status,
    fen: game.fen(),
    board: game.board().map((rank) =>
      rank.map((piece) =>
        piece ? { color: piece.color, type: piece.type } : null
      )
    ),
    turn: game.turn(),
    playerColor,
    playerName: playerColor === "w" ? match.whiteName : match.blackName,
    opponentName: playerColor === "w" ? match.blackName : match.whiteName,
    legalMoves: match.status === "active" && game.turn() === playerColor
      ? game.moves({ verbose: true }).map((move) => ({
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
      }))
      : [],
    check: game.isCheck(),
    turnDeadlineAt: match.turnDeadlineAt || null,
    clockMs: match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS },
    winnerColor: match.winnerColor || null,
    won: match.status === "completed" && match.draw !== true && (
      match.winnerUid === uid ||
      (match.mode === "bot" && match.winnerColor === "w" &&
        match.whiteUid === uid)
    ),
    draw: match.draw === true,
    result: match.result || "",
    payout: (match.payouts as JsonRecord | undefined)?.[uid] || 0,
    lastMove: Array.isArray(match.moves) && match.moves.length
      ? match.moves[match.moves.length - 1]
      : null,
  };
}

export function createWhotGame({ random = Math.random, handSize = 6 }: {
  random?: () => number;
  handSize?: number;
} = {}): JsonRecord {
  const cards: JsonRecord[] = [];
  let sequence = 0;
  for (const suit of WHOT_SUITS) {
    for (const value of WHOT_SUIT_VALUES[suit]) {
      cards.push({ id: `card-${sequence++}`, suit, value });
    }
  }
  for (let index = 0; index < 5; index++) {
    cards.push({ id: `card-${sequence++}`, suit: "whot", value: 20 });
  }
  for (let index = cards.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [cards[index], cards[target]] = [cards[target], cards[index]];
  }

  const hands = {
    w: cards.splice(0, handSize),
    b: cards.splice(0, handSize),
  };
  const starterIndex = cards.findIndex((card) =>
    !WHOT_SPECIAL_VALUES.includes(Number(card.value))
  );
  if (starterIndex < 0) {
    throw new Error("The Whot deck has no valid opening card.");
  }
  [cards[0], cards[starterIndex]] = [cards[starterIndex], cards[0]];
  return {
    hands,
    market: cards.slice(1),
    discard: [cards[0]],
    currentPlayer: "w",
    pendingDraw: null,
    requestedSuit: null,
    status: "active",
    winnerColor: null,
    draw: false,
    result: "",
    lastAction: "Game started",
  };
}

export function legalWhotCards(
  game: JsonRecord,
  color = game.currentPlayer as Color,
): JsonRecord[] {
  if (!game || game.status !== "active" || !["w", "b"].includes(color)) {
    return [];
  }
  const hands = game.hands as Record<Color, JsonRecord[]>;
  const hand = hands[color] || [];
  const pendingDraw = game.pendingDraw as JsonRecord | null;
  if (pendingDraw) {
    return hand.filter((card) => card.value === pendingDraw.value);
  }
  if (game.requestedSuit) {
    return hand.filter((card) =>
      card.value === 20 || card.suit === game.requestedSuit
    );
  }
  const discard = game.discard as JsonRecord[];
  const topCard = discard[discard.length - 1];
  if (!topCard) return [];
  return hand.filter((card) =>
    card.value === 20 || card.suit === topCard.suit ||
    card.value === topCard.value
  );
}

export function passWhotTurn(game: JsonRecord): JsonRecord {
  if (!game || game.status !== "active") {
    throw new Error("This Whot game has ended.");
  }
  const next = structuredClone(game);
  next.currentPlayer = game.currentPlayer === "w" ? "b" : "w";
  next.lastAction = "Turn timed out — turn passed";
  return next;
}

function shuffle(items: JsonRecord[], random: () => number): JsonRecord[] {
  for (let index = items.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

function drawWhotCards(
  game: JsonRecord,
  color: Color,
  count: number,
  random: () => number,
): number {
  const hands = game.hands as Record<Color, JsonRecord[]>;
  const market = game.market as JsonRecord[];
  const discard = game.discard as JsonRecord[];
  let drawn = 0;
  while (drawn < count) {
    if (!market.length) {
      if (discard.length <= 1) break;
      const topCard = discard.pop()!;
      game.market = shuffle(discard.splice(0), random);
      discard.push(topCard);
    }
    if (!market.length) break;
    hands[color].push(market.shift()!);
    drawn++;
  }
  return drawn;
}

function finishWhotIfLocked(game: JsonRecord): void {
  if (game.status !== "active") return;
  const hands = game.hands as Record<Color, JsonRecord[]>;
  if (hands.w.length === 0 || hands.b.length === 0) {
    game.status = "completed";
    game.winnerColor = hands.w.length === 0 ? "w" : "b";
    game.result = "First to clear their hand";
    return;
  }
  if (
    (game.market as JsonRecord[]).length ||
    (game.discard as JsonRecord[]).length > 1
  ) return;
  if (legalWhotCards(game, "w").length || legalWhotCards(game, "b").length) {
    return;
  }
  game.status = "completed";
  game.draw = true;
  game.result = "No playable cards remain";
}

export function applyWhotAction(
  game: JsonRecord,
  color: Color,
  action: JsonRecord,
  { random = Math.random }: { random?: () => number } = {},
): JsonRecord {
  if (!game || game.status !== "active") {
    throw new Error("This Whot game has ended.");
  }
  if (color !== game.currentPlayer) {
    throw new Error("Wait for your turn before playing.");
  }
  if (!action || typeof action !== "object") {
    throw new Error("Choose a valid Whot action.");
  }

  const next = structuredClone(game);
  const other: Color = color === "w" ? "b" : "w";
  const hands = next.hands as Record<Color, JsonRecord[]>;
  const discard = next.discard as JsonRecord[];
  if (action.type === "draw") {
    const pendingDraw = next.pendingDraw as JsonRecord | null;
    const count = pendingDraw ? Number(pendingDraw.count) : 1;
    const drawn = drawWhotCards(next, color, count, random);
    next.pendingDraw = null;
    next.currentPlayer = other;
    next.lastAction = drawn
      ? `Drew ${drawn}${drawn === 1 ? " card" : " cards"}`
      : "The market was empty";
    finishWhotIfLocked(next);
    return next;
  }
  if (action.type !== "play" || typeof action.cardId !== "string") {
    throw new Error("Choose a card to play or draw.");
  }

  const cardIndex = hands[color].findIndex((card) => card.id === action.cardId);
  if (cardIndex < 0) throw new Error("That card is not in your hand.");
  const card = hands[color][cardIndex];
  if (
    !legalWhotCards(next, color).some((legalCard) => legalCard.id === card.id)
  ) {
    throw new Error("That card does not match the call card.");
  }
  if (card.value === 20 && !WHOT_SUITS.includes(String(action.requestedSuit))) {
    throw new Error("Choose a shape for the Whot card.");
  }

  hands[color].splice(cardIndex, 1);
  discard.push(card);
  next.requestedSuit = card.value === 20 ? action.requestedSuit : null;
  next.lastAction = card.value === 20
    ? `Whot called ${String(action.requestedSuit)}`
    : `Played ${String(card.value)} ${String(card.suit)}`;

  if (hands[color].length === 0) {
    next.status = "completed";
    next.winnerColor = color;
    next.result = "First to clear their hand";
    return next;
  }

  const pendingDraw = next.pendingDraw as JsonRecord | null;
  if (WHOT_PENALTY_VALUES.includes(Number(card.value))) {
    const count = pendingDraw ? Number(pendingDraw.count) : 0;
    next.pendingDraw = {
      value: card.value,
      count: count + (card.value === 2 ? 2 : 3),
    };
    next.currentPlayer = other;
  } else if (card.value === 1 || card.value === 8) {
    next.currentPlayer = color;
  } else if (card.value === 14) {
    drawWhotCards(next, other, 1, random);
    next.currentPlayer = color;
  } else {
    next.pendingDraw = null;
    next.currentPlayer = other;
  }
  finishWhotIfLocked(next);
  return next;
}

export function chooseWhotAction(
  game: JsonRecord,
  color = game.currentPlayer as Color,
): JsonRecord {
  const legalCards = legalWhotCards(game, color);
  if (!legalCards.length) return { type: "draw" };

  const other: Color = color === "w" ? "b" : "w";
  const hands = game.hands as Record<Color, JsonRecord[]>;
  const remaining = hands[color].filter((card) =>
    !legalCards.some((legalCard) => legalCard.id === card.id)
  );
  const suitCounts = Object.fromEntries(WHOT_SUITS.map((suit) => [
    suit,
    remaining.filter((card) => card.suit === suit).length,
  ])) as Record<string, number>;
  const bestSuit = WHOT_SUITS.reduce(
    (best, suit) => suitCounts[suit] > suitCounts[best] ? suit : best,
    WHOT_SUITS[0],
  );
  const opponentCount = hands[other].length;
  const ranked = legalCards.map((card) => {
    let score = card.value === 20
      ? suitCounts[bestSuit] * 8 + 5
      : suitCounts[String(card.suit)] * 8;
    if (hands[color].length === 1) score += 1000;
    if (card.value === 2 || card.value === 5) {
      score += 24 + Math.max(0, 7 - opponentCount) * 3;
    }
    if (card.value === 1 || card.value === 8 || card.value === 14) score += 18;
    if (card.value === 20 && hands[color].length > 2) score -= 4;
    return { card, score };
  }).sort((left, right) =>
    right.score - left.score ||
    String(left.card.id).localeCompare(String(right.card.id))
  );
  const chosen = ranked[0].card;
  return {
    type: "play",
    cardId: chosen.id,
    ...(chosen.value === 20 ? { requestedSuit: bestSuit } : {}),
  };
}

export function getWhotOutcome(game: JsonRecord): GameResult | null {
  const hands = game.hands as Record<Color, JsonRecord[]>;
  if (game.status === "completed") {
    return {
      draw: game.draw === true,
      winnerColor: game.winnerColor === "w" || game.winnerColor === "b"
        ? game.winnerColor
        : null,
      result: String(game.result || ""),
    };
  }
  if (hands.w.length === 0) {
    return {
      draw: false,
      winnerColor: "w",
      result: "First to clear their hand",
    };
  }
  if (hands.b.length === 0) {
    return {
      draw: false,
      winnerColor: "b",
      result: "First to clear their hand",
    };
  }
  if (
    !(game.market as JsonRecord[]).length &&
    (game.discard as JsonRecord[]).length <= 1 &&
    !legalWhotCards(game, "w").length && !legalWhotCards(game, "b").length
  ) {
    return {
      draw: true,
      winnerColor: null,
      result: "No playable cards remain",
    };
  }
  return null;
}

function makeWhotMatch({
  mode,
  stake,
  timeMinutes,
  whiteUid,
  blackUid,
  whiteName,
  blackName,
}: {
  mode: string;
  stake: number;
  timeMinutes: number;
  whiteUid: string;
  blackUid: string | null;
  whiteName: string;
  blackName: string;
}): JsonRecord {
  const now = Date.now();
  const turnTimeMs = selectedClockMs(timeMinutes);
  return {
    mode,
    stake,
    timeMinutes,
    turnTimeMs,
    whiteUid,
    blackUid,
    whiteName,
    blackName,
    gameState: createWhotGame(),
    status: "active",
    clockMs: { w: turnTimeMs, b: turnTimeMs },
    turnStartedAt: now,
    turnDeadlineAt: now + turnTimeMs,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildWhotMatchView(match: JsonRecord, uid: string): JsonRecord {
  const playerColor = whotColorForUid(match, uid);
  if (!playerColor) {
    throw new ApiError(
      403,
      "permission-denied",
      "You are not a player in this Whot match.",
    );
  }
  const game = match.gameState as JsonRecord;
  const opponentColor: Color = playerColor === "w" ? "b" : "w";
  const hands = game.hands as Record<Color, JsonRecord[]>;
  const hand = hands[playerColor];
  const discard = game.discard as JsonRecord[];
  return {
    id: match.id,
    mode: match.mode,
    stake: match.stake,
    timeMinutes: Number(match.timeMinutes) || 10,
    turnTimeMs: whotTurnTimeMs(match),
    status: match.status,
    playerColor,
    playerName: playerColor === "w" ? match.whiteName : match.blackName,
    opponentName: playerColor === "w" ? match.blackName : match.whiteName,
    hand,
    opponentCardCount: hands[opponentColor].length,
    topCard: discard[discard.length - 1],
    marketCount: (game.market as JsonRecord[]).length,
    currentPlayer: game.currentPlayer,
    legalCardIds:
      match.status === "active" && game.currentPlayer === playerColor
        ? legalWhotCards(game, playerColor).map((card) => card.id)
        : [],
    pendingDraw: game.pendingDraw,
    requestedSuit: game.requestedSuit,
    lastAction: game.lastAction,
    turnDeadlineAt: match.turnDeadlineAt || null,
    clockMs: match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS },
    winnerColor: match.winnerColor || null,
    won: match.status === "completed" && match.draw !== true && (
      match.winnerUid === uid ||
      (match.mode === "bot" && match.winnerColor === "w" &&
        match.whiteUid === uid)
    ),
    draw: match.draw === true,
    result: match.result || "",
    payout: (match.payouts as JsonRecord | undefined)?.[uid] || 0,
  };
}

async function getAccountSnapshots(
  transaction: FirestoreTransaction,
  uids: string[],
): Promise<Map<string, FirestoreDocument>> {
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  const snapshots = await Promise.all(
    uniqueUids.map((uid) => transaction.get(`users/${uid}`)),
  );
  return new Map(
    snapshots.map((snapshot, index) => [uniqueUids[index], snapshot]),
  );
}

async function finishGameTransaction(
  transaction: FirestoreTransaction,
  collection: "chessMatches" | "whotMatches",
  matchId: string,
  match: JsonRecord,
  result: GameResult,
  gameName: "Chess" | "Whot",
  finalFields: JsonRecord = {},
): Promise<void> {
  const players = [match.whiteUid, match.blackUid].filter((
    uid,
  ): uid is string => typeof uid === "string" && uid.length > 0);
  const snapshots = await getAccountSnapshots(transaction, players);
  let payouts: Record<string, number>;
  try {
    payouts = calculatePayouts(match, result, gameName.toLowerCase());
  } catch (error) {
    throw new ApiError(
      500,
      "internal",
      error instanceof Error ? error.message : `Could not settle ${gameName}.`,
    );
  }

  const updates: Array<
    { uid: string; user: JsonRecord; amount: number; balance: number }
  > = [];
  for (const uid of players) {
    const snapshot = snapshots.get(uid);
    if (!snapshot?.exists) {
      throw new ApiError(
        412,
        "failed-precondition",
        `A player account is unavailable; ${gameName} settlement needs administrator review.`,
      );
    }
    const user = snapshot.data;
    const currentBalance = Number(user.balance || 0);
    const amount = Number(payouts[uid] || 0);
    const nextBalance = currentBalance + amount;
    if (
      !Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
      !Number.isSafeInteger(amount) || amount < 0 ||
      !Number.isSafeInteger(nextBalance)
    ) {
      throw new ApiError(
        412,
        "failed-precondition",
        "A wallet balance cannot safely accept the game result.",
      );
    }
    updates.push({ uid, user, amount, balance: nextBalance });
  }

  const settledAt = new Date();
  const gameSlug = gameName.toLowerCase();
  for (const update of updates) {
    const isRefund = result.draw;
    const type = isRefund
      ? "game_refund"
      : update.amount > 0
      ? "game_payout"
      : "game_loss";
    const description = isRefund
      ? `${gameName} draw — stake refunded`
      : update.amount > 0
      ? `${gameName} match won`
      : `${gameName} match lost`;
    transaction.update(`users/${update.uid}`, { balance: update.balance });
    transaction.set(
      `transactions/${gameSlug}_${matchId}_${update.uid}`,
      ledgerData({
        uid: update.uid,
        user: update.user,
        type,
        description,
        amount: update.amount,
        stake: Number(match.stake),
        matchId,
        game: gameSlug,
      }),
    );
  }
  transaction.update(`${collection}/${matchId}`, {
    status: "completed",
    winnerUid: result.winnerUid || null,
    winnerColor: result.winnerColor || null,
    draw: result.draw === true,
    result: result.result,
    payouts,
    completedAt: settledAt,
    updatedAt: settledAt,
    ...finalFields,
  });
  for (const uid of players) {
    transaction.delete(`${gameSlug}Players/${uid}`);
    transaction.set(`${gameSlug}Queue/${uid}`, {
      status: "complete",
      matchId,
      updatedAt: settledAt,
    }, true);
  }
}

function randomInt(max: number): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
}

function chessBotUnavailable(): never {
  throw new ApiError(
    503,
    "unavailable",
    "Chess bot play is unavailable: the Stockfish Node.js package has not been verified for Supabase Deno Edge.",
  );
}

async function startChessBot(
  _principal: FirebasePrincipal,
  _data: JsonRecord,
): Promise<JsonRecord> {
  chessBotUnavailable();
}

async function startWhotBot(
  principal: FirebasePrincipal,
  data: JsonRecord,
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const stake = parseStake(data.stake, "Whot");
  const timeMinutes = parseTimeMinutes(data.timeMinutes, "Whot");
  const matchId = newFirestoreDocumentId();
  const userPath = `users/${uid}`;
  const presencePath = `whotPlayers/${uid}`;
  const queuePath = `whotQueue/${uid}`;

  return await runFirestoreTransaction(async (transaction) => {
    const [userSnapshot, presenceSnapshot, queueSnapshot] = await Promise.all([
      transaction.get(userPath),
      transaction.get(presencePath),
      transaction.get(queuePath),
    ]);
    if (presenceSnapshot.exists) {
      const presence = presenceSnapshot.data;
      if (presence.status === "active" && presence.matchId) {
        return { matchId: presence.matchId, existing: true };
      }
      if (
        presence.status === "waiting" && queueSnapshot.exists &&
        !isExpiredQueue(queueSnapshot.data)
      ) {
        throw new ApiError(
          412,
          "failed-precondition",
          "Cancel Whot matchmaking before starting a bot game.",
        );
      }
      transaction.delete(presencePath);
      transaction.delete(queuePath);
    }

    const user = userSnapshot.exists ? userSnapshot.data : null;
    const balance = validateAccount(user, stake, "Whot");
    const match = makeWhotMatch({
      mode: "bot",
      stake,
      timeMinutes,
      whiteUid: uid,
      blackUid: null,
      whiteName: accountName(user!, uid),
      blackName: "Whot Bot",
    });
    transaction.update(userPath, { balance: balance - stake });
    transaction.set(
      `transactions/${newFirestoreDocumentId()}`,
      ledgerData({
        uid,
        user: user!,
        type: "game_stake",
        description: "Whot vs bot stake",
        amount: -stake,
        stake,
        matchId,
        game: "whot",
      }),
    );
    transaction.set(`whotMatches/${matchId}`, match);
    transaction.set(presencePath, {
      status: "active",
      mode: "bot",
      stake,
      timeMinutes,
      matchId,
      updatedAt: new Date(),
    });
    return { matchId, existing: false };
  });
}

async function joinQueue(
  principal: FirebasePrincipal,
  data: JsonRecord,
  gameSlug: "chess" | "whot",
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const gameName = gameSlug === "chess" ? "Chess" : "Whot";
  const stake = parseStake(data.stake, gameName);
  const timeMinutes = parseTimeMinutes(data.timeMinutes, gameName);
  const collection = gameSlug === "chess" ? "chessMatches" : "whotMatches";
  const userPath = `users/${uid}`;
  const ownQueuePath = `${gameSlug}Queue/${uid}`;
  const ownPresencePath = `${gameSlug}Players/${uid}`;
  const matchId = newFirestoreDocumentId();
  const ownStakePath = `transactions/${newFirestoreDocumentId()}`;
  const queueQuery: FirestoreQuery = {
    collection: `${gameSlug}Queue`,
    filters: [
      { fieldPath: "stake", value: stake },
      { fieldPath: "status", value: "waiting" },
    ],
    limit: 20,
  };

  return await runFirestoreTransaction(async (transaction) => {
    const [userSnapshot, ownQueueSnapshot, ownPresenceSnapshot, queueDocs] =
      await Promise.all([
        transaction.get(userPath),
        transaction.get(ownQueuePath),
        transaction.get(ownPresencePath),
        transaction.query(queueQuery),
      ]);

    if (ownPresenceSnapshot.exists) {
      const ownPresence = ownPresenceSnapshot.data;
      if (ownPresence.status === "active" && ownPresence.matchId) {
        return {
          status: "matched",
          matchId: ownPresence.matchId,
          existing: true,
        };
      }
      if (
        ownPresence.status === "waiting" &&
        (Number(ownPresence.stake) !== stake ||
          Number(ownPresence.timeMinutes || 10) !== timeMinutes) &&
        (gameSlug === "chess" || ownQueueSnapshot.exists) &&
        !isExpiredQueue(
          gameSlug === "chess" ? ownPresence : ownQueueSnapshot.data,
        )
      ) {
        throw new ApiError(
          412,
          "failed-precondition",
          `Cancel your current ${gameName} queue before changing the stake or clock.`,
        );
      }
    }

    const user = userSnapshot.exists ? userSnapshot.data : null;
    let balance: number;
    try {
      balance = validateAccount(user, stake, gameName);
    } catch (error) {
      if (
        gameSlug === "chess" &&
        (ownPresenceSnapshot.exists || ownQueueSnapshot.exists)
      ) {
        transaction.delete(ownPresencePath);
        transaction.delete(ownQueuePath);
        return {
          error: error instanceof Error
            ? error.message
            : "Your account cannot join the queue.",
          code: error instanceof ApiError ? error.code : "failed-precondition",
        };
      }
      throw error;
    }

    const candidates = queueDocs.filter((doc) => doc.id !== uid);
    const candidateRefs = candidates.map((doc) => ({
      presencePath: `${gameSlug}Players/${doc.id}`,
      userPath: `users/${doc.id}`,
    }));
    const candidateSnapshots = await Promise.all(
      candidateRefs.flatMap((paths) => [
        transaction.get(paths.presencePath),
        transaction.get(paths.userPath),
      ]),
    );
    const staleUids: string[] = [];
    let opponent: {
      uid: string;
      queue: FirestoreQueryDocument;
      userPath: string;
      user: JsonRecord;
      balance: number;
    } | null = null;

    for (let index = 0; index < candidates.length; index++) {
      const queue = candidates[index];
      const presenceSnapshot = candidateSnapshots[index * 2];
      const opponentSnapshot = candidateSnapshots[index * 2 + 1];
      const queueData = queue.data;
      if (Number(queueData.timeMinutes || 10) !== timeMinutes) continue;
      const available = !isExpiredQueue(queueData) &&
        presenceSnapshot.exists &&
        presenceSnapshot.data.status === "waiting" &&
        Number(presenceSnapshot.data.stake) === stake &&
        Number(presenceSnapshot.data.timeMinutes || 10) === timeMinutes &&
        accountIsAvailable(
          opponentSnapshot.exists ? opponentSnapshot.data : null,
          stake,
        );
      if (!available) {
        staleUids.push(queue.id);
        continue;
      }
      opponent = {
        uid: queue.id,
        queue,
        userPath: candidateRefs[index].userPath,
        user: opponentSnapshot.data,
        balance: Number(opponentSnapshot.data.balance),
      };
      break;
    }

    for (const staleUid of staleUids) {
      transaction.delete(`${gameSlug}Players/${staleUid}`);
      transaction.set(`${gameSlug}Queue/${staleUid}`, {
        status: "expired",
        updatedAt: new Date(),
      }, true);
    }

    if (!opponent) {
      const ownPresence = ownPresenceSnapshot.exists
        ? ownPresenceSnapshot.data
        : null;
      const stillWaiting = ownPresence?.status === "waiting" &&
        Number(ownPresence.stake) === stake &&
        Number(ownPresence.timeMinutes || 10) === timeMinutes &&
        (gameSlug === "chess" || ownQueueSnapshot.exists) &&
        !isExpiredQueue(
          gameSlug === "chess" ? ownPresence : ownQueueSnapshot.data,
        );
      if (!stillWaiting) {
        transaction.set(ownQueuePath, {
          uid,
          stake,
          timeMinutes,
          status: "waiting",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        transaction.set(ownPresencePath, {
          status: "waiting",
          mode: "human",
          stake,
          timeMinutes,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { status: "waiting", stake };
    }

    const opponentQueueData = opponent.queue.data;
    const opponentStakePath = `transactions/${newFirestoreDocumentId()}`;
    const ownPlayer = {
      uid,
      user: user!,
      balance,
      queuePath: ownQueuePath,
      presencePath: ownPresencePath,
      stakePath: ownStakePath,
    };
    const opponentPlayer = {
      uid: opponent.uid,
      user: opponent.user,
      balance: opponent.balance,
      queuePath: opponent.queue.path,
      presencePath: `${gameSlug}Players/${opponent.uid}`,
      stakePath: opponentStakePath,
    };
    const white = randomInt(2) === 0 ? ownPlayer : opponentPlayer;
    const black = white.uid === uid ? opponentPlayer : ownPlayer;
    const match = gameSlug === "chess"
      ? makeChessMatch({
        mode: "human",
        stake,
        timeMinutes,
        whiteUid: white.uid,
        blackUid: black.uid,
        whiteName: accountName(white.user, white.uid),
        blackName: accountName(black.user, black.uid),
      })
      : makeWhotMatch({
        mode: "human",
        stake,
        timeMinutes,
        whiteUid: white.uid,
        blackUid: black.uid,
        whiteName: accountName(white.user, white.uid),
        blackName: accountName(black.user, black.uid),
      });

    transaction.update(userPath, { balance: balance - stake });
    transaction.update(opponent.userPath, {
      balance: opponent.balance - stake,
    });
    for (const player of [white, black]) {
      transaction.set(
        player.stakePath,
        ledgerData({
          uid: player.uid,
          user: player.user,
          type: "game_stake",
          description: `${gameName} human match stake`,
          amount: -stake,
          stake,
          matchId,
          game: gameSlug,
        }),
      );
      transaction.set(player.queuePath, {
        uid: player.uid,
        stake,
        timeMinutes,
        status: "matched",
        matchId,
        createdAt: player.uid === uid
          ? new Date()
          : opponentQueueData.createdAt || new Date(),
        updatedAt: new Date(),
      });
      transaction.set(player.presencePath, {
        status: "active",
        mode: "human",
        stake,
        timeMinutes,
        matchId,
        updatedAt: new Date(),
      });
    }
    transaction.set(`${collection}/${matchId}`, match);
    return { status: "matched", matchId, existing: false };
  });
}

async function queueStatus(
  principal: FirebasePrincipal,
  gameSlug: "chess" | "whot",
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  return await runFirestoreTransaction(async (transaction) => {
    const queuePath = `${gameSlug}Queue/${uid}`;
    const presencePath = `${gameSlug}Players/${uid}`;
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queuePath),
      transaction.get(presencePath),
    ]);
    if (!presenceSnapshot.exists) return { status: "idle" };
    const presence = presenceSnapshot.data;
    if (presence.status === "active" && presence.matchId) {
      return { status: "matched", matchId: presence.matchId };
    }
    if (!queueSnapshot.exists || presence.status !== "waiting") {
      return { status: "idle" };
    }
    if (isExpiredQueue(queueSnapshot.data)) {
      transaction.delete(queuePath);
      transaction.delete(presencePath);
      return { status: "expired" };
    }
    return {
      status: "waiting",
      stake: Number(presence.stake),
      timeMinutes: Number(presence.timeMinutes) || 10,
    };
  });
}

async function cancelQueue(
  principal: FirebasePrincipal,
  gameSlug: "chess" | "whot",
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const result = await runFirestoreTransaction(async (transaction) => {
    const queuePath = `${gameSlug}Queue/${uid}`;
    const presencePath = `${gameSlug}Players/${uid}`;
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queuePath),
      transaction.get(presencePath),
    ]);
    if (presenceSnapshot.exists && presenceSnapshot.data.status === "active") {
      return {
        status: "active",
        ...(gameSlug === "chess"
          ? { matchId: presenceSnapshot.data.matchId || null }
          : {}),
      };
    }
    if (queueSnapshot.exists) transaction.delete(queuePath);
    if (presenceSnapshot.exists) transaction.delete(presencePath);
    return { status: "cancelled" };
  });
  if (result.status === "active") {
    throw new ApiError(
      412,
      "failed-precondition",
      "This request has already matched. Resign from the match if you want to end it.",
    );
  }
  return result;
}

async function settleChessTimeout(matchId: string): Promise<JsonRecord> {
  return await runFirestoreTransaction(async (transaction) => {
    const path = `chessMatches/${matchId}`;
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Chess match not found.");
    }
    const match = snapshot.data;
    if (
      match.status !== "active" ||
      Number(match.turnDeadlineAt || 0) > Date.now()
    ) return match;
    const game = createChessGame((match.moves || []) as JsonRecord[]);
    const timedOutColor = game.turn();
    const winnerColor: Color = timedOutColor === "w" ? "b" : "w";
    const winnerUid = winnerColor === "w"
      ? String(match.whiteUid)
      : String(match.blackUid);
    const result = {
      draw: false,
      winnerColor,
      winnerUid,
      result: "Time expired — opponent wins",
    };
    await finishGameTransaction(
      transaction,
      "chessMatches",
      matchId,
      match,
      result,
      "Chess",
    );
    return {
      ...match,
      status: "completed",
      winnerUid,
      winnerColor,
      draw: false,
      result: result.result,
    };
  });
}

async function settleWhotTimeout(matchId: string): Promise<JsonRecord> {
  return await runFirestoreTransaction(async (transaction) => {
    const path = `whotMatches/${matchId}`;
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Whot match not found.");
    }
    const match = snapshot.data;
    if (
      match.status !== "active" ||
      Number(match.turnDeadlineAt || 0) > Date.now()
    ) return match;
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const gameState = passWhotTurn(match.gameState as JsonRecord);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    transaction.update(path, {
      gameState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: new Date(),
    });
    return {
      ...match,
      gameState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
    };
  });
}

async function applyChessBotMove(_matchId: string): Promise<void> {
  chessBotUnavailable();
}

async function applyWhotBotMove(matchId: string): Promise<void> {
  const token = newFirestoreDocumentId();
  const claim = await runFirestoreTransaction(async (transaction) => {
    const path = `whotMatches/${matchId}`;
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Whot match not found.");
    }
    const match = snapshot.data;
    const gameState = match.gameState as JsonRecord;
    if (
      match.status !== "active" || match.mode !== "bot" ||
      gameState.currentPlayer !== "b"
    ) return null;
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) {
      return { expired: true as const };
    }
    if (
      match.botThinkingAt && Date.now() - Number(match.botThinkingAt) < 30_000
    ) return null;
    transaction.update(path, {
      botThinkingAt: Date.now(),
      botThinkingToken: token,
    });
    return { gameState, expired: false as const };
  });
  if (!claim) return;
  if (claim.expired) {
    await settleWhotTimeout(matchId);
    return;
  }

  const action = chooseWhotAction(claim.gameState, "b");
  const continueBotTurn = await runFirestoreTransaction(async (transaction) => {
    const path = `whotMatches/${matchId}`;
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Whot match not found.");
    }
    const match = snapshot.data;
    if (
      match.status !== "active" || match.mode !== "bot" ||
      match.botThinkingToken !== token
    ) return false;
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    if (Number(match.turnDeadlineAt || 0) <= now) {
      const nextState = passWhotTurn(match.gameState as JsonRecord);
      transaction.update(path, {
        gameState: nextState,
        clockMs,
        turnStartedAt: now,
        turnDeadlineAt: now + turnTimeMs,
        botThinkingAt: null,
        botThinkingToken: null,
        updatedAt: new Date(),
      });
      return false;
    }
    let nextState: JsonRecord;
    try {
      nextState = applyWhotAction(match.gameState as JsonRecord, "b", action);
    } catch (error) {
      throw new ApiError(
        500,
        "internal",
        error instanceof Error ? error.message : "Whot bot action failed.",
      );
    }
    const outcome = getWhotOutcome(nextState);
    if (outcome) {
      const winnerUid = outcome.winnerColor === "w"
        ? String(match.whiteUid)
        : outcome.winnerColor === "b"
        ? String(match.blackUid)
        : null;
      await finishGameTransaction(
        transaction,
        "whotMatches",
        matchId,
        match,
        { ...outcome, winnerUid },
        "Whot",
        {
          gameState: nextState,
          clockMs,
          botThinkingAt: null,
          botThinkingToken: null,
        },
      );
      return false;
    }
    transaction.update(path, {
      gameState: nextState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: new Date(),
    });
    return nextState.currentPlayer === "b";
  });
  if (continueBotTurn) await applyWhotBotMove(matchId);
}

async function getChessMatch(
  principal: FirebasePrincipal,
  data: JsonRecord,
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const matchId = parseMatchId(data.matchId, "chess");
  const path = `chessMatches/${matchId}`;
  let snapshot = await getFirestoreDocument(path);
  if (!snapshot.exists) {
    throw new ApiError(404, "not-found", "Chess match not found.");
  }
  let match: JsonRecord = { id: matchId, ...snapshot.data };
  if (!chessColorForUid(match, uid)) {
    throw new ApiError(
      403,
      "permission-denied",
      "You are not a player in this chess match.",
    );
  }
  if (
    match.status === "active" && Number(match.turnDeadlineAt || 0) <= Date.now()
  ) {
    await settleChessTimeout(matchId);
    snapshot = await getFirestoreDocument(path);
    match = { id: matchId, ...snapshot.data };
  } else if (match.status === "active" && match.mode === "bot") {
    const game = createChessGame((match.moves || []) as JsonRecord[]);
    if (game.turn() === "b") {
      await applyChessBotMove(matchId);
      snapshot = await getFirestoreDocument(path);
      match = { id: matchId, ...snapshot.data };
    }
  }
  return buildChessMatchView(match, uid);
}

async function getWhotMatch(
  principal: FirebasePrincipal,
  data: JsonRecord,
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const matchId = parseMatchId(data.matchId, "Whot");
  const path = `whotMatches/${matchId}`;
  let snapshot = await getFirestoreDocument(path);
  if (!snapshot.exists) {
    throw new ApiError(404, "not-found", "Whot match not found.");
  }
  let match: JsonRecord = { id: matchId, ...snapshot.data };
  if (!whotColorForUid(match, uid)) {
    throw new ApiError(
      403,
      "permission-denied",
      "You are not a player in this Whot match.",
    );
  }
  if (
    match.status === "active" && Number(match.turnDeadlineAt || 0) <= Date.now()
  ) {
    await settleWhotTimeout(matchId);
    snapshot = await getFirestoreDocument(path);
    match = { id: matchId, ...snapshot.data };
  }
  if (
    match.status === "active" && match.mode === "bot" &&
    (match.gameState as JsonRecord).currentPlayer === "b"
  ) {
    await applyWhotBotMove(matchId);
    snapshot = await getFirestoreDocument(path);
    match = { id: matchId, ...snapshot.data };
  }
  return buildWhotMatchView(match, uid);
}

async function playChessMove(
  principal: FirebasePrincipal,
  data: JsonRecord,
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const matchId = parseMatchId(data.matchId, "chess");
  const path = `chessMatches/${matchId}`;
  const moveInput = { from: data.from, to: data.to, promotion: data.promotion };
  await runFirestoreTransaction(async (transaction) => {
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Chess match not found.");
    }
    const match = snapshot.data;
    const playerColor = chessColorForUid(match, uid);
    if (!playerColor) {
      throw new ApiError(
        403,
        "permission-denied",
        "You are not a player in this chess match.",
      );
    }
    if (match.status !== "active") {
      throw new ApiError(
        412,
        "failed-precondition",
        "This chess match has already ended.",
      );
    }
    const game = createChessGame((match.moves || []) as JsonRecord[]);
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) {
      const timedOutColor = game.turn();
      const winnerColor: Color = timedOutColor === "w" ? "b" : "w";
      const winnerUid = winnerColor === "w"
        ? String(match.whiteUid)
        : String(match.blackUid);
      await finishGameTransaction(
        transaction,
        "chessMatches",
        matchId,
        match,
        {
          draw: false,
          winnerUid,
          winnerColor,
          result: "Time expired — opponent wins",
        },
        "Chess",
      );
      return;
    }
    if (playerColor !== game.turn()) {
      throw new ApiError(
        412,
        "failed-precondition",
        "Wait for your turn before moving.",
      );
    }
    let applied: ReturnType<ChessGame["move"]>;
    try {
      applied = applyChessMove(game, moveInput);
    } catch (error) {
      throw new ApiError(
        400,
        "invalid-argument",
        error instanceof Error
          ? error.message
          : "That is not a legal chess move.",
      );
    }
    if (!applied) {
      throw new ApiError(
        400,
        "invalid-argument",
        "That is not a legal chess move.",
      );
    }
    const moves = [...(match.moves || []) as JsonRecord[], {
      from: applied.from,
      to: applied.to,
      ...(applied.promotion ? { promotion: applied.promotion } : {}),
      san: applied.san,
      color: applied.color,
    }];
    const outcome = getChessOutcome(game);
    if (outcome) {
      const result = {
        ...outcome,
        winnerUid: outcome.winnerColor === "w"
          ? String(match.whiteUid)
          : outcome.winnerColor === "b"
          ? String(match.blackUid)
          : null,
      };
      await finishGameTransaction(
        transaction,
        "chessMatches",
        matchId,
        match,
        result,
        "Chess",
        { moves, fen: game.fen() },
      );
      return;
    }
    const now = Date.now();
    const clockMs = {
      ...((match.clockMs ||
        { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS }) as Record<Color, number>),
    };
    clockMs[applied.color as Color] = Math.max(
      0,
      clockMs[applied.color as Color] -
        (now - Number(match.turnStartedAt || now)),
    );
    if (clockMs[applied.color as Color] === 0) {
      const winnerColor: Color = applied.color === "w" ? "b" : "w";
      const winnerUid = winnerColor === "w"
        ? String(match.whiteUid)
        : String(match.blackUid);
      await finishGameTransaction(
        transaction,
        "chessMatches",
        matchId,
        match,
        {
          draw: false,
          winnerUid,
          winnerColor,
          result: "Time expired — opponent wins",
        },
        "Chess",
        { moves, fen: game.fen(), clockMs },
      );
      return;
    }
    transaction.update(path, {
      moves,
      fen: game.fen(),
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + clockMs[game.turn() as Color],
      updatedAt: new Date(),
    });
  });

  let latest = await getFirestoreDocument(path);
  if (
    latest.exists && latest.data.status === "active" &&
    latest.data.mode === "bot"
  ) {
    await applyChessBotMove(matchId);
  }
  latest = await getFirestoreDocument(path);
  if (!latest.exists) {
    throw new ApiError(404, "not-found", "Chess match not found.");
  }
  return buildChessMatchView({ id: matchId, ...latest.data }, uid);
}

async function commitWhotAction(
  principal: FirebasePrincipal,
  data: JsonRecord,
  action: JsonRecord,
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const matchId = parseMatchId(data.matchId, "Whot");
  const path = `whotMatches/${matchId}`;
  await runFirestoreTransaction(async (transaction) => {
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", "Whot match not found.");
    }
    const match = snapshot.data;
    const color = whotColorForUid(match, uid);
    if (!color) {
      throw new ApiError(
        403,
        "permission-denied",
        "You are not a player in this Whot match.",
      );
    }
    if (match.status !== "active") {
      throw new ApiError(
        412,
        "failed-precondition",
        "This Whot match has already ended.",
      );
    }
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    let turnState = match.gameState as JsonRecord;
    if (Number(match.turnDeadlineAt || 0) <= now) {
      turnState = passWhotTurn(turnState);
      if (color !== turnState.currentPlayer) {
        transaction.update(path, {
          gameState: turnState,
          clockMs,
          turnStartedAt: now,
          turnDeadlineAt: now + turnTimeMs,
          botThinkingAt: null,
          botThinkingToken: null,
          updatedAt: new Date(),
        });
        return;
      }
    }
    if (color !== turnState.currentPlayer) {
      throw new ApiError(
        412,
        "failed-precondition",
        "Wait for your turn before playing.",
      );
    }

    let gameState: JsonRecord;
    try {
      gameState = applyWhotAction(turnState, color, action);
    } catch (error) {
      throw new ApiError(
        400,
        "invalid-argument",
        error instanceof Error ? error.message : "Choose a valid Whot action.",
      );
    }
    const outcome = getWhotOutcome(gameState);
    if (outcome) {
      const winnerUid = outcome.winnerColor === "w"
        ? String(match.whiteUid)
        : outcome.winnerColor === "b"
        ? String(match.blackUid)
        : null;
      await finishGameTransaction(
        transaction,
        "whotMatches",
        matchId,
        match,
        { ...outcome, winnerUid },
        "Whot",
        { gameState, clockMs },
      );
      return;
    }
    transaction.update(path, {
      gameState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: new Date(),
    });
  });

  let latest = await getFirestoreDocument(path);
  if (
    latest.exists && latest.data.status === "active" &&
    latest.data.mode === "bot" &&
    (latest.data.gameState as JsonRecord).currentPlayer === "b"
  ) {
    await applyWhotBotMove(matchId);
  }
  latest = await getFirestoreDocument(path);
  if (!latest.exists) {
    throw new ApiError(404, "not-found", "Whot match not found.");
  }
  return buildWhotMatchView({ id: matchId, ...latest.data }, uid);
}

async function resignGame(
  principal: FirebasePrincipal,
  data: JsonRecord,
  gameSlug: "chess" | "whot",
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const gameName = gameSlug === "chess" ? "Chess" : "Whot";
  const matchId = parseMatchId(data.matchId, gameSlug);
  const collection = `${gameSlug}Matches` as "chessMatches" | "whotMatches";
  const path = `${collection}/${matchId}`;
  await runFirestoreTransaction(async (transaction) => {
    const snapshot = await transaction.get(path);
    if (!snapshot.exists) {
      throw new ApiError(404, "not-found", `${gameName} match not found.`);
    }
    const match = snapshot.data;
    const color = chessColorForUid(match, uid);
    if (!color) {
      throw new ApiError(
        403,
        "permission-denied",
        `You are not a player in this ${gameName} match.`,
      );
    }
    if (match.status !== "active") return;
    const winnerColor: Color = color === "w" ? "b" : "w";
    const winnerUid = winnerColor === "w"
      ? String(match.whiteUid)
      : String(match.blackUid);
    await finishGameTransaction(
      transaction,
      collection,
      matchId,
      match,
      { draw: false, winnerColor, winnerUid, result: "Resignation" },
      gameName,
    );
  });
  return gameSlug === "chess"
    ? getChessMatch(principal, { matchId })
    : getWhotMatch(principal, { matchId });
}

async function getCurrentGame(
  principal: FirebasePrincipal,
  gameSlug: "chess" | "whot",
): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const presence = await getFirestoreDocument(`${gameSlug}Players/${uid}`);
  if (!presence.exists) return { status: "idle" };
  const data = presence.data;
  if (data.status === "waiting") {
    return {
      status: "waiting",
      stake: Number(data.stake),
      timeMinutes: Number(data.timeMinutes) || 10,
    };
  }
  if (data.status !== "active" || !data.matchId) return { status: "idle" };
  return gameSlug === "chess"
    ? getChessMatch(principal, { matchId: data.matchId })
    : getWhotMatch(principal, { matchId: data.matchId });
}

export const gameHandlers: Record<
  string,
  (principal: FirebasePrincipal, data: JsonRecord) => Promise<JsonRecord>
> = {
  chessStartBot: startChessBot,
  chessJoinQueue: (principal, data) => joinQueue(principal, data, "chess"),
  chessQueueStatus: (principal) => queueStatus(principal, "chess"),
  chessCancelQueue: (principal) => cancelQueue(principal, "chess"),
  chessGetCurrent: (principal) => getCurrentGame(principal, "chess"),
  chessGetMatch: getChessMatch,
  chessMove: playChessMove,
  chessResign: (principal, data) => resignGame(principal, data, "chess"),
  whotStartBot: startWhotBot,
  whotJoinQueue: (principal, data) => joinQueue(principal, data, "whot"),
  whotQueueStatus: (principal) => queueStatus(principal, "whot"),
  whotCancelQueue: (principal) => cancelQueue(principal, "whot"),
  whotGetCurrent: (principal) => getCurrentGame(principal, "whot"),
  whotGetMatch: getWhotMatch,
  whotPlay: (principal, data) =>
    commitWhotAction(principal, data, {
      type: "play",
      cardId: data.cardId,
      requestedSuit: data.requestedSuit,
    }),
  whotDraw: (principal, data) =>
    commitWhotAction(principal, data, { type: "draw" }),
  whotResign: (principal, data) => resignGame(principal, data, "whot"),
};

const SUITS = ['circle', 'triangle', 'cross', 'square', 'star'];
const SUIT_VALUES = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8]
};
const PENALTY_VALUES = [2, 5];
const SPECIAL_VALUES = [1, 2, 5, 8, 14, 20];

function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

function createWhotGame({ random = Math.random, handSize = 6 } = {}) {
  const cards = [];
  let sequence = 0;
  for (const suit of SUITS) {
    for (const value of SUIT_VALUES[suit]) {
      cards.push({ id: 'card-' + sequence++, suit, value });
    }
  }
  for (let index = 0; index < 5; index++) {
    cards.push({ id: 'card-' + sequence++, suit: 'whot', value: 20 });
  }
  shuffle(cards, random);

  const hands = {
    w: cards.splice(0, handSize),
    b: cards.splice(0, handSize)
  };
  const starterIndex = cards.findIndex(card => !SPECIAL_VALUES.includes(card.value));
  if (starterIndex < 0) throw new Error('The Whot deck has no valid opening card.');
  [cards[0], cards[starterIndex]] = [cards[starterIndex], cards[0]];

  return {
    hands,
    market: cards.slice(1),
    discard: [cards[0]],
    currentPlayer: 'w',
    pendingDraw: null,
    requestedSuit: null,
    status: 'active',
    winnerColor: null,
    draw: false,
    result: '',
    lastAction: 'Game started'
  };
}

function legalWhotCards(game, color = game.currentPlayer) {
  if (!game || game.status !== 'active' || !['w', 'b'].includes(color)) return [];
  const hand = game.hands[color] || [];
  if (game.pendingDraw) {
    return hand.filter(card => card.value === game.pendingDraw.value);
  }
  if (game.requestedSuit) {
    return hand.filter(card => card.value === 20 || card.suit === game.requestedSuit);
  }
  const topCard = game.discard[game.discard.length - 1];
  if (!topCard) return [];
  return hand.filter(card => card.value === 20 || card.suit === topCard.suit || card.value === topCard.value);
}

function passWhotTurn(game) {
  if (!game || game.status !== 'active') throw new Error('This Whot game has ended.');
  const next = structuredClone(game);
  next.currentPlayer = game.currentPlayer === 'w' ? 'b' : 'w';
  next.lastAction = 'Turn timed out — turn passed';
  return next;
}

function recycleMarket(game, random) {
  if (game.market.length) return true;
  if (game.discard.length <= 1) return false;
  const topCard = game.discard.pop();
  game.market = shuffle(game.discard.splice(0), random);
  game.discard.push(topCard);
  return game.market.length > 0;
}

function drawCards(game, color, count, random) {
  let drawn = 0;
  while (drawn < count) {
    if (!recycleMarket(game, random)) break;
    game.hands[color].push(game.market.shift());
    drawn++;
  }
  return drawn;
}

function finishIfLocked(game) {
  if (game.status !== 'active') return;
  if (game.hands.w.length === 0 || game.hands.b.length === 0) {
    game.status = 'completed';
    game.winnerColor = game.hands.w.length === 0 ? 'w' : 'b';
    game.result = 'First to clear their hand';
    return;
  }
  if (game.market.length || game.discard.length > 1) return;
  if (legalWhotCards(game, 'w').length || legalWhotCards(game, 'b').length) return;
  game.status = 'completed';
  game.draw = true;
  game.result = 'No playable cards remain';
}

function applyWhotAction(game, color, action, { random = Math.random } = {}) {
  if (!game || game.status !== 'active') throw new Error('This Whot game has ended.');
  if (color !== game.currentPlayer) throw new Error('Wait for your turn before playing.');
  if (!action || typeof action !== 'object') throw new Error('Choose a valid Whot action.');

  const next = structuredClone(game);
  const other = color === 'w' ? 'b' : 'w';
  if (action.type === 'draw') {
    const count = next.pendingDraw ? next.pendingDraw.count : 1;
    const drawn = drawCards(next, color, count, random);
    next.pendingDraw = null;
    next.currentPlayer = other;
    next.lastAction = drawn
      ? 'Drew ' + drawn + (drawn === 1 ? ' card' : ' cards')
      : 'The market was empty';
    finishIfLocked(next);
    return next;
  }
  if (action.type !== 'play' || typeof action.cardId !== 'string') {
    throw new Error('Choose a card to play or draw.');
  }

  const cardIndex = next.hands[color].findIndex(card => card.id === action.cardId);
  if (cardIndex < 0) throw new Error('That card is not in your hand.');
  const card = next.hands[color][cardIndex];
  if (!legalWhotCards(next, color).some(legalCard => legalCard.id === card.id)) {
    throw new Error('That card does not match the call card.');
  }
  if (card.value === 20 && !SUITS.includes(action.requestedSuit)) {
    throw new Error('Choose a shape for the Whot card.');
  }

  next.hands[color].splice(cardIndex, 1);
  next.discard.push(card);
  next.requestedSuit = card.value === 20 ? action.requestedSuit : null;
  next.lastAction = card.value === 20
    ? 'Whot called ' + action.requestedSuit
    : 'Played ' + card.value + ' ' + card.suit;

  if (next.hands[color].length === 0) {
    next.status = 'completed';
    next.winnerColor = color;
    next.result = 'First to clear their hand';
    return next;
  }

  if (PENALTY_VALUES.includes(card.value)) {
    const count = next.pendingDraw ? next.pendingDraw.count : 0;
    next.pendingDraw = { value: card.value, count: count + (card.value === 2 ? 2 : 3) };
    next.currentPlayer = other;
  } else if (card.value === 1 || card.value === 8) {
    next.currentPlayer = color;
  } else if (card.value === 14) {
    drawCards(next, other, 1, random);
    next.currentPlayer = color;
  } else {
    next.pendingDraw = null;
    next.currentPlayer = other;
  }
  finishIfLocked(next);
  return next;
}

function chooseWhotAction(game, color = game.currentPlayer) {
  const legalCards = legalWhotCards(game, color);
  if (!legalCards.length) return { type: 'draw' };

  const other = color === 'w' ? 'b' : 'w';
  const remaining = game.hands[color].filter(card => !legalCards.some(legalCard => legalCard.id === card.id));
  const suitCounts = Object.fromEntries(SUITS.map(suit => [
    suit,
    remaining.filter(card => card.suit === suit).length
  ]));
  const bestSuit = SUITS.reduce((best, suit) => suitCounts[suit] > suitCounts[best] ? suit : best, SUITS[0]);
  const opponentCount = game.hands[other].length;

  const ranked = legalCards.map(card => {
    let score = card.value === 20 ? suitCounts[bestSuit] * 8 + 5 : suitCounts[card.suit] * 8;
    if (game.hands[color].length === 1) score += 1000;
    if (card.value === 2 || card.value === 5) score += 24 + Math.max(0, 7 - opponentCount) * 3;
    if (card.value === 1 || card.value === 8 || card.value === 14) score += 18;
    if (card.value === 20 && game.hands[color].length > 2) score -= 4;
    return { card, score };
  }).sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id));
  const chosen = ranked[0].card;
  return {
    type: 'play',
    cardId: chosen.id,
    ...(chosen.value === 20 ? { requestedSuit: bestSuit } : {})
  };
}

function getWhotOutcome(game) {
  if (game.status === 'completed') {
    return { draw: game.draw === true, winnerColor: game.winnerColor || null, result: game.result };
  }
  if (game.hands.w.length === 0) return { draw: false, winnerColor: 'w', result: 'First to clear their hand' };
  if (game.hands.b.length === 0) return { draw: false, winnerColor: 'b', result: 'First to clear their hand' };
  if (!game.market.length && game.discard.length <= 1
      && !legalWhotCards(game, 'w').length && !legalWhotCards(game, 'b').length) {
    return { draw: true, winnerColor: null, result: 'No playable cards remain' };
  }
  return null;
}

function calculateWhotPayouts(match, result) {
  if (!Number.isSafeInteger(match.stake) || match.stake < 1 || !Number.isSafeInteger(match.stake * 2)) {
    throw new Error('The Whot stake cannot be safely settled.');
  }
  if (result.draw) {
    const refunds = { [match.whiteUid]: match.stake };
    if (match.mode !== 'bot') refunds[match.blackUid] = match.stake;
    return refunds;
  }
  if (match.mode === 'bot') {
    if (!['w', 'b'].includes(result.winnerColor)) throw new Error('The Whot result has no winner.');
    return result.winnerColor === 'w'
      ? { [match.whiteUid]: match.stake * 2 }
      : { [match.whiteUid]: 0 };
  }
  if (!result.winnerUid) throw new Error('The Whot result has no winner.');
  return { [result.winnerUid]: match.stake * 2 };
}

module.exports = {
  SUITS,
  createWhotGame,
  legalWhotCards,
  passWhotTurn,
  applyWhotAction,
  chooseWhotAction,
  getWhotOutcome,
  calculateWhotPayouts
};

const { Chess } = require('chess.js');

function createChessGame(moves = []) {
  const game = new Chess();
  for (const move of moves) {
    const applied = game.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {})
    });
    if (!applied) throw new Error('Stored chess history contains an illegal move.');
  }
  return game;
}

function applyChessMove(game, move) {
  if (!move || typeof move.from !== 'string' || typeof move.to !== 'string') {
    throw new Error('Choose a valid chess move.');
  }
  const promotion = move.promotion ? String(move.promotion).toLowerCase() : undefined;
  if (promotion && !['q', 'r', 'b', 'n'].includes(promotion)) {
    throw new Error('Choose a valid promotion piece.');
  }
  return game.move({
    from: move.from,
    to: move.to,
    ...(promotion ? { promotion } : {})
  });
}

function getChessOutcome(game) {
  if (!game.isGameOver()) return null;
  if (game.isCheckmate()) {
    return {
      draw: false,
      winnerColor: game.turn() === 'w' ? 'b' : 'w',
      result: 'Checkmate'
    };
  }
  if (game.isStalemate()) return { draw: true, winnerColor: null, result: 'Draw by stalemate' };
  if (game.isThreefoldRepetition()) return { draw: true, winnerColor: null, result: 'Draw by threefold repetition' };
  if (game.isInsufficientMaterial()) return { draw: true, winnerColor: null, result: 'Draw by insufficient material' };
  if (game.isDraw()) return { draw: true, winnerColor: null, result: 'Draw by the 50-move rule' };
  return { draw: true, winnerColor: null, result: 'Draw' };
}

function calculateChessPayouts(match, result) {
  if (!Number.isSafeInteger(match.stake) || match.stake < 1 || !Number.isSafeInteger(match.stake * 2)) {
    throw new Error('The chess stake cannot be safely settled.');
  }
  if (result.draw) {
    const refunds = { [match.whiteUid]: match.stake };
    if (match.mode !== 'bot') refunds[match.blackUid] = match.stake;
    return refunds;
  }
  if (match.mode === 'bot') {
    if (!['w', 'b'].includes(result.winnerColor)) throw new Error('The chess result has no winner.');
    return result.winnerColor === 'w'
      ? { [match.whiteUid]: match.stake * 2 }
      : { [match.whiteUid]: 0 };
  }
  if (!result.winnerUid) throw new Error('The chess result has no winner.');
  return { [result.winnerUid]: match.stake * 2 };
}

module.exports = { createChessGame, applyChessMove, getChessOutcome, calculateChessPayouts };

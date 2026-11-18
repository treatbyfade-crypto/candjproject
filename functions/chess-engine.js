const stockfish = require('stockfish');
const DEFAULT_MOVE_TIME_MS = 5000;

function findBestMove(fen, moveTimeMs = DEFAULT_MOVE_TIME_MS) {
  return new Promise((resolve, reject) => {
    let engine;
    let settled = false;
    let outputBuffer = '';
    let readyRequested = false;
    let searchStarted = false;
    const timeout = setTimeout(() => finish(new Error('The chess engine did not respond in time.')), moveTimeMs + 15000);

    function finish(error, move) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (engine) setImmediate(() => engine.terminate());
      if (error) reject(error);
      else resolve(move);
    }

    try {
      engine = stockfish('lite-single', line => {
        outputBuffer += String(line || '');
        if (!readyRequested && outputBuffer.includes('uciok')) {
          readyRequested = true;
          setImmediate(() => {
            engine.processCommand('setoption name Skill Level value 20');
            engine.processCommand('setoption name Hash value 64');
            engine.processCommand('isready');
          });
        }
        if (readyRequested && !searchStarted && outputBuffer.includes('readyok')) {
          searchStarted = true;
          setImmediate(() => {
            engine.processCommand('position fen ' + fen);
            engine.processCommand('go movetime ' + moveTimeMs);
          });
        }
        const bestMoves = outputBuffer.match(/bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?|none)/g);
        const bestMove = bestMoves && bestMoves.length ? bestMoves[bestMoves.length - 1].match(/bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?|none)/) : null;
        if (bestMove) {
          finish(null, bestMove[1] === 'none' ? null : bestMove[1]);
        }
      });
      engine.processCommand('uci');
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = { findBestMove };

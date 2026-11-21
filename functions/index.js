const { randomInt, randomUUID, randomBytes, pbkdf2, timingSafeEqual } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2/options');
const { createChessGame, applyChessMove, getChessOutcome, calculateChessPayouts } = require('./chess-logic');
const { findBestMove } = require('./chess-engine');
const {
  createWhotGame,
  legalWhotCards,
  passWhotTurn,
  applyWhotAction,
  chooseWhotAction,
  getWhotOutcome,
  calculateWhotPayouts
} = require('./whot-logic');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

const db = getFirestore();
const MIN_STAKE = 3000;
const PLAYER_CLOCK_MS = 10 * 60 * 1000;
const TIME_OPTIONS_MINUTES = [1, 3, 5, 10];
const QUEUE_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_EARNING_AMOUNT = 1000;

function requireUid(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before playing chess.');
  return request.auth.uid;
}

function verifyTransferPin(pin, salt, expectedHash) {
  return new Promise((resolve, reject) => {
    pbkdf2(pin, Buffer.from(salt, 'base64'), 180000, 32, 'sha256', (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      const expected = Buffer.from(expectedHash, 'base64');
      resolve(expected.length === derivedKey.length && timingSafeEqual(expected, derivedKey));
    });
  });
}

function deriveTransferPinHash(pin, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(pin, salt, 180000, 32, 'sha256', (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('base64'));
    });
  });
}

async function setTransferPin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before setting a Transfer PIN.');
  const uid = request.auth.uid;
  const pin = request.data && request.data.pin;
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    throw new HttpsError('invalid-argument', 'Transfer PIN must contain 4 to 6 digits.');
  }
  const userRef = db.collection('users').doc(uid);
  const pinRef = db.collection('transferPins').doc(uid);
  const salt = randomBytes(16).toString('base64');
  const hash = await deriveTransferPinHash(pin, Buffer.from(salt, 'base64'));
  await db.runTransaction(async transaction => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) throw new HttpsError('not-found', 'Your account record could not be found.');
    transaction.set(pinRef, {
      salt,
      hash,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(userRef, {
      hasTransferPin: true,
      transferPinSalt: FieldValue.delete(),
      transferPinHash: FieldValue.delete(),
      transferPinUpdatedAt: FieldValue.delete()
    });
  });
  return { hasTransferPin: true };
}

async function transferWallet(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before sending a transfer.');
  const uid = request.auth.uid;
  const { recipientId, amount: rawAmount, note: rawNote = '', pin, requestId } = request.data || {};
  const amount = Number(rawAmount);
  if (typeof recipientId !== 'string' || !recipientId || recipientId.length > 128 || recipientId === uid) {
    throw new HttpsError('invalid-argument', 'Choose another valid C&J member.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new HttpsError('invalid-argument', 'Transfer amount must be a positive whole number.');
  }
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    throw new HttpsError('invalid-argument', 'Enter your 4 to 6 digit Transfer PIN.');
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{20,36}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'This transfer request is invalid. Try again.');
  }
  const note = typeof rawNote === 'string' ? rawNote.trim().slice(0, 240) : '';
  const senderRef = db.collection('users').doc(uid);
  const recipientRef = db.collection('users').doc(recipientId);
  const pinRef = db.collection('transferPins').doc(uid);
  const attemptsRef = db.collection('transferPinAttempts').doc(uid);
  const [senderSnapshot, pinSnapshot, attemptsSnapshot] = await Promise.all([
    senderRef.get(),
    pinRef.get(),
    attemptsRef.get()
  ]);
  if (!senderSnapshot.exists) throw new HttpsError('not-found', 'Your account record could not be found.');
  const senderData = senderSnapshot.data();
  const legacyPin = !pinSnapshot.exists;
  const pinData = pinSnapshot.exists
    ? pinSnapshot.data()
    : { salt: senderData.transferPinSalt, hash: senderData.transferPinHash };
  const lockedUntil = Number(attemptsSnapshot.exists ? attemptsSnapshot.data().lockedUntil || 0 : 0);
  if (lockedUntil > Date.now()) {
    throw new HttpsError('resource-exhausted', 'Too many incorrect PIN attempts. Try again later.');
  }
  if (typeof pinData.salt !== 'string' || typeof pinData.hash !== 'string') {
    throw new HttpsError('failed-precondition', 'Create a Transfer PIN in Settings before requesting a transfer.');
  }
  if (!await verifyTransferPin(pin, pinData.salt, pinData.hash)) {
    await db.runTransaction(async transaction => {
      const currentAttempts = await transaction.get(attemptsRef);
      const now = Date.now();
      const recentFailures = currentAttempts.exists && now - Number(currentAttempts.data().windowStartedAt || 0) < 15 * 60 * 1000
        ? Number(currentAttempts.data().failedCount || 0)
        : 0;
      const failedCount = recentFailures + 1;
      transaction.set(attemptsRef, {
        failedCount,
        windowStartedAt: recentFailures ? Number(currentAttempts.data().windowStartedAt) : now,
        lockedUntil: failedCount >= 5 ? now + 15 * 60 * 1000 : 0
      });
    });
    throw new HttpsError('permission-denied', 'Incorrect Transfer PIN.');
  }
  if (legacyPin) {
    await db.runTransaction(async transaction => {
      const [currentUser, currentPin] = await Promise.all([
        transaction.get(senderRef),
        transaction.get(pinRef)
      ]);
      if (!currentPin.exists && currentUser.exists &&
          currentUser.data().transferPinSalt === pinData.salt &&
          currentUser.data().transferPinHash === pinData.hash) {
        transaction.set(pinRef, {
          salt: pinData.salt,
          hash: pinData.hash,
          updatedAt: FieldValue.serverTimestamp()
        });
        transaction.update(senderRef, {
          hasTransferPin: true,
          transferPinSalt: FieldValue.delete(),
          transferPinHash: FieldValue.delete(),
          transferPinUpdatedAt: FieldValue.delete()
        });
      }
    });
  }
  await attemptsRef.set({ failedCount: 0, windowStartedAt: Date.now(), lockedUntil: 0 });

  const requestRef = db.collection('walletTransfers').doc(uid + '_' + requestId);
  const senderLedgerRef = db.collection('transactions').doc('transfer_' + uid + '_' + requestId + '_sent');
  const recipientLedgerRef = db.collection('transactions').doc('transfer_' + uid + '_' + requestId + '_received');
  const senderNotificationRef = db.collection('notifications').doc();
  const recipientNotificationRef = db.collection('notifications').doc();

  return db.runTransaction(async transaction => {
    const [existingRequest, currentSender, currentPin, recipientSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(senderRef),
      transaction.get(pinRef),
      transaction.get(recipientRef)
    ]);
    if (existingRequest.exists) {
      const saved = existingRequest.data();
      if (saved.senderId !== uid || saved.recipientId !== recipientId || saved.amount !== amount) {
        throw new HttpsError('already-exists', 'This transfer request ID was already used.');
      }
      return { balance: saved.senderBalanceAfter, recipientName: saved.recipientName, amount };
    }
    if (!currentSender.exists || !recipientSnapshot.exists) {
      throw new HttpsError('not-found', 'Sender or recipient account could not be found.');
    }
    if (!currentPin.exists || currentPin.data().salt !== pinData.salt || currentPin.data().hash !== pinData.hash) {
      throw new HttpsError('failed-precondition', 'Your Transfer PIN changed. Try again.');
    }
    const sender = currentSender.data();
    const recipient = recipientSnapshot.data();
    if (!sender.membership?.active) {
      throw new HttpsError('failed-precondition', 'Activate your membership before sending transfers.');
    }
    if (['frozen', 'disabled'].includes(sender.accountStatus)) {
      throw new HttpsError('permission-denied', 'Your account cannot send transfers while restricted.');
    }
    if (['frozen', 'disabled'].includes(recipient.accountStatus)) {
      throw new HttpsError('failed-precondition', 'This recipient account cannot receive transfers.');
    }
    const senderBalance = Number(sender.balance || 0);
    const recipientBalance = Number(recipient.balance || 0);
    if (!Number.isSafeInteger(senderBalance) || senderBalance < amount ||
        !Number.isSafeInteger(recipientBalance) || recipientBalance < 0 ||
        !Number.isSafeInteger(recipientBalance + amount)) {
      throw new HttpsError('failed-precondition', 'A wallet balance is invalid or insufficient.');
    }
    const senderName = accountName(sender, uid);
    const recipientName = accountName(recipient, recipientId);
    const now = FieldValue.serverTimestamp();
    const senderBalanceAfter = senderBalance - amount;
    transaction.update(senderRef, { balance: senderBalanceAfter });
    transaction.update(recipientRef, { balance: recipientBalance + amount });
    transaction.set(senderLedgerRef, {
      userId: uid, userName: senderName, personName: recipientName,
      type: 'transfer_sent', amount: -amount, recipientUserId: recipientId,
      recipientName, note, date: now, status: 'completed'
    });
    transaction.set(recipientLedgerRef, {
      userId: recipientId, userName: recipientName, personName: senderName,
      type: 'transfer_received', amount, senderUserId: uid, senderName,
      note, date: now, status: 'completed'
    });
    transaction.set(senderNotificationRef, {
      userId: uid, title: 'Transfer sent',
      message: 'N' + amount.toLocaleString() + ' sent to ' + recipientName + '.',
      read: false, createdAt: now
    });
    transaction.set(recipientNotificationRef, {
      userId: recipientId, title: 'Transfer received',
      message: 'N' + amount.toLocaleString() + ' received from ' + senderName + '.',
      read: false, createdAt: now
    });
    transaction.create(requestRef, {
      senderId: uid, recipientId, amount, senderBalanceAfter, recipientName,
      createdAt: now
    });
    return { balance: senderBalanceAfter, recipientName, amount };
  });
}

async function adjustWalletAsAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before adjusting a wallet.');
  const adminEmail = String(request.auth.token.email || '').trim().toLowerCase();
  if (adminEmail !== 'admin@cj.com') {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
  const {
    userId,
    balanceType = 'wallet',
    action,
    amount: rawAmount,
    reason: rawReason = '',
    requestId
  } = request.data || {};
  const amount = Number(rawAmount);
  if (typeof userId !== 'string' || !userId || userId.length > 128) {
    throw new HttpsError('invalid-argument', 'Choose a valid member account.');
  }
  if (!['wallet', 'lagosLife'].includes(balanceType) ||
      !['credit', 'debit'].includes(action) ||
      (balanceType === 'lagosLife' && action !== 'credit')) {
    throw new HttpsError('invalid-argument', 'This wallet adjustment type is invalid.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new HttpsError('invalid-argument', 'Enter a positive whole-number amount.');
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{20,36}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'This adjustment request is invalid. Try again.');
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 240) : '';
  const adminUid = request.auth.uid;
  const userRef = db.collection('users').doc(userId);
  const ledgerCollection = balanceType === 'lagosLife' ? 'lagosLifeTransactions' : 'transactions';
  const balanceField = balanceType === 'lagosLife' ? 'lagosLifeBalance' : 'balance';
  const requestRef = db.collection('adminWalletAdjustments').doc(adminUid + '_' + requestId);
  const ledgerRef = db.collection(ledgerCollection).doc('admin_' + adminUid + '_' + requestId);
  const notificationRef = db.collection('notifications').doc();
  return db.runTransaction(async transaction => {
    const [existingRequest, userSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(userRef)
    ]);
    if (existingRequest.exists) {
      const saved = existingRequest.data();
      if (saved.userId !== userId || saved.balanceType !== balanceType ||
          saved.action !== action || saved.amount !== amount) {
        throw new HttpsError('already-exists', 'This adjustment request ID was already used.');
      }
      return { balance: saved.balanceAfter, memberName: saved.memberName };
    }
    if (!userSnapshot.exists) throw new HttpsError('not-found', 'Member account could not be found.');
    const user = userSnapshot.data();
    const currentBalance = Number(user[balanceField] || 0);
    const balanceAfter = action === 'credit' ? currentBalance + amount : currentBalance - amount;
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
        !Number.isSafeInteger(balanceAfter) || balanceAfter < 0) {
      throw new HttpsError('failed-precondition', 'The wallet balance cannot safely accept this adjustment.');
    }
    const memberName = String(user.name || user.email || userId).slice(0, 80);
    const signedAmount = action === 'credit' ? amount : -amount;
    const label = action === 'credit' ? 'Balance credited' : 'Balance debited';
    const now = FieldValue.serverTimestamp();
    transaction.update(userRef, { [balanceField]: balanceAfter });
    transaction.set(ledgerRef, {
      userId,
      userName: memberName,
      userEmail: String(user.email || ''),
      type: balanceType === 'lagosLife' ? 'admin_credit' : 'admin_' + action,
      personName: memberName,
      description: label + ' by administrator: ' + (reason || 'Administrator balance adjustment'),
      amount: signedAmount,
      date: now,
      status: 'completed',
      adminId: adminUid,
      adminName: String(request.auth.token.name || 'Administrator').slice(0, 80),
      reason
    });
    transaction.set(notificationRef, {
      userId,
      title: balanceType === 'lagosLife' ? 'Lagos Life funds added' : label,
      message: balanceType === 'lagosLife'
        ? 'An administrator added N' + amount.toLocaleString() + ' to your Lagos Life balance. Reason: ' + (reason || 'Administrator Lagos Life funding') + '.'
        : 'Your wallet balance was ' + (action === 'credit' ? 'increased' : 'decreased') + ' by N' + amount.toLocaleString() + '. Reason: ' + (reason || 'Administrator balance adjustment') + '.',
      read: false,
      createdAt: now,
      type: action === 'credit' ? 'deposit' : 'withdrawal'
    });
    transaction.create(requestRef, {
      adminId: adminUid,
      userId,
      balanceType,
      action,
      amount,
      balanceAfter,
      memberName,
      createdAt: now
    });
    return { balance: balanceAfter, memberName };
  });
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const millis = new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function assertRewardAccount(data) {
  if (!data) throw new HttpsError('not-found', 'Your account record could not be found.');
  if (['frozen', 'disabled'].includes(data.accountStatus)) {
    throw new HttpsError('permission-denied', 'Your account cannot earn while restricted.');
  }
  if (data.membership?.active !== true) {
    throw new HttpsError('failed-precondition', 'Your membership must be active first.');
  }
}

async function claimDailyEarning(request) {
  const uid = requireUid(request);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async transaction => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) throw new HttpsError('not-found', 'Your account record could not be found.');
    const user = userSnapshot.data();
    assertRewardAccount(user);
    const now = Date.now();
    const membership = user.membership || {};
    const dueAt = timestampMillis(membership.nextEarningAt) ||
      (timestampMillis(membership.startAt) !== null ? timestampMillis(membership.startAt) + DAY_MS : null);
    const lastCheckin = timestampMillis(user.dailyCheckin && user.dailyCheckin.lastCheckinAt) ||
      timestampMillis(membership.startAt);
    const currentBalance = Number(user.balance || 0);
    const totalEarned = Number(user.totalEarned || 0);
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
        !Number.isSafeInteger(totalEarned) || totalEarned < 0) {
      throw new HttpsError('failed-precondition', 'Your wallet or earnings balance is invalid.');
    }
    if (dueAt === null || now < dueAt || lastCheckin === null || now - lastCheckin >= DAY_MS) {
      return { credited: false, balance: currentBalance, totalEarned, nextEarningAt: dueAt };
    }
    const ledgerId = 'daily_' + uid + '_' + dueAt;
    const ledgerRef = db.collection('transactions').doc(ledgerId);
    const ledgerSnapshot = await transaction.get(ledgerRef);
    if (ledgerSnapshot.exists) {
      return { credited: false, balance: currentBalance, totalEarned, nextEarningAt: dueAt };
    }
    const balance = currentBalance + DAILY_EARNING_AMOUNT;
    const earned = totalEarned + DAILY_EARNING_AMOUNT;
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(earned)) {
      throw new HttpsError('failed-precondition', 'Your wallet cannot safely accept this earning.');
    }
    const nextEarningAt = dueAt + DAY_MS;
    transaction.update(userRef, {
      balance,
      totalEarned: earned,
      'membership.nextEarningAt': new Date(nextEarningAt)
    });
    transaction.create(ledgerRef, {
      userId: uid,
      userName: accountName(user, uid),
      type: 'earning',
      description: 'Daily C&J earning',
      amount: DAILY_EARNING_AMOUNT,
      date: FieldValue.serverTimestamp(),
      status: 'completed'
    });
    return { credited: true, amount: DAILY_EARNING_AMOUNT, balance, totalEarned: earned, nextEarningAt };
  });
}

async function claimDailyCheckin(request) {
  const uid = requireUid(request);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async transaction => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) throw new HttpsError('not-found', 'Your account record could not be found.');
    const user = userSnapshot.data();
    assertRewardAccount(user);
    const membership = user.membership || {};
    if (membership.status && membership.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Check-in is available after your membership is approved.');
    }
    const now = Date.now();
    const previous = timestampMillis(user.dailyCheckin && user.dailyCheckin.lastCheckinAt);
    if (previous !== null && now - previous < DAY_MS) {
      throw new HttpsError('failed-precondition', 'Your next check-in is available ' + new Date(previous + DAY_MS).toISOString() + '.');
    }
    const dueAt = timestampMillis(membership.nextEarningAt);
    let earningLedgerRef = null;
    let earningLedgerExists = false;
    if (previous !== null && dueAt !== null && dueAt > previous && dueAt <= previous + DAY_MS && now >= dueAt) {
      earningLedgerRef = db.collection('transactions').doc('daily_' + uid + '_' + dueAt);
      earningLedgerExists = (await transaction.get(earningLedgerRef)).exists;
    }
    const earning = earningLedgerRef && !earningLedgerExists ? DAILY_EARNING_AMOUNT : 0;
    const previousDay = Number(user.dailyCheckin && user.dailyCheckin.day || 0);
    const missedDeadline = previous === null || now - previous >= DAY_MS;
    const nextDay = missedDeadline ? 1 : previousDay >= 7 ? 1 : previousDay + 1;
    const balance = Number(user.balance || 0);
    const totalEarned = Number(user.totalEarned || 0);
    if (!Number.isSafeInteger(balance) || balance < 0 ||
        !Number.isSafeInteger(totalEarned) || totalEarned < 0) {
      throw new HttpsError('failed-precondition', 'Your wallet or earnings balance is invalid.');
    }
    const updatedBalance = balance + earning;
    const updatedTotalEarned = totalEarned + earning;
    if (!Number.isSafeInteger(updatedBalance) || !Number.isSafeInteger(updatedTotalEarned)) {
      throw new HttpsError('failed-precondition', 'Your wallet cannot safely accept this earning.');
    }
    const checkedInAt = new Date(now);
    const nextEarningAt = membership.active && missedDeadline ? now + DAY_MS : dueAt;
    transaction.update(userRef, {
      dailyCheckin: {
        lastCheckinAt: checkedInAt,
        day: nextDay,
        registeredAt: (user.dailyCheckin && user.dailyCheckin.registeredAt) || user.createdAt || checkedInAt
      },
      ...(earning ? {
        balance: updatedBalance,
        totalEarned: updatedTotalEarned
      } : {}),
      ...(membership.active && missedDeadline ? {
        'membership.nextEarningAt': new Date(nextEarningAt)
      } : {})
    });
    if (earningLedgerRef && earning) {
      transaction.create(earningLedgerRef, {
        userId: uid,
        userName: accountName(user, uid),
        type: 'earning',
        description: 'Daily C&J earning',
        amount: earning,
        date: FieldValue.serverTimestamp(),
        status: 'completed'
      });
    }
    return {
      day: nextDay,
      checkedInAt: now,
      earning,
      earningLedgerId: earningLedgerRef && earning ? earningLedgerRef.id : '',
      balance: updatedBalance,
      totalEarned: updatedTotalEarned,
      nextEarningAt
    };
  });
}

function parseStake(value) {
  const stake = Number(value);
  if (!Number.isSafeInteger(stake) || stake < MIN_STAKE || stake > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new HttpsError('invalid-argument', 'Chess stakes must be at least N3,000 and within the safe wallet calculation range.');
  }
  return stake;
}

function parseTimeMinutes(value, gameName) {
  const minutes = Number(value);
  if (!TIME_OPTIONS_MINUTES.includes(minutes)) {
    throw new HttpsError('invalid-argument', gameName + ' time must be 1, 3, 5, or 10 minutes.');
  }
  return minutes;
}

function selectedClockMs(minutes) {
  return minutes * 60 * 1000;
}

function whotTurnTimeMs(match) {
  const saved = Number(match.turnTimeMs);
  if (Number.isSafeInteger(saved) && saved > 0) return saved;
  return selectedClockMs(Number(match.timeMinutes) || 10);
}

function validateAccount(data, stake) {
  if (!data) throw new HttpsError('failed-precondition', 'Your account record could not be found.');
  if (['frozen', 'disabled'].includes(data.accountStatus)) {
    throw new HttpsError('permission-denied', 'Your account is restricted from playing.');
  }
  if (data.membership?.active !== true) {
    throw new HttpsError('failed-precondition', 'Your membership must be active before playing chess.');
  }
  const balance = Number(data.balance || 0);
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new HttpsError('failed-precondition', 'Your wallet balance is invalid.');
  }
  if (balance < stake) {
    throw new HttpsError('failed-precondition', 'Your available wallet balance is too low for this stake.');
  }
  return balance;
}

function accountName(data, uid) {
  return String(data.name || data.username || uid).slice(0, 80);
}

function gameFromMatch(match) {
  return createChessGame(match.moves || []);
}

function colorForUid(match, uid) {
  if (match.whiteUid === uid) return 'w';
  if (match.blackUid === uid) return 'b';
  return null;
}

function isExpiredQueue(queue, now = Date.now()) {
  const createdAt = queue.createdAt && typeof queue.createdAt.toMillis === 'function'
    ? queue.createdAt.toMillis()
    : 0;
  return !createdAt || now - createdAt > QUEUE_TTL_MS;
}

function ledgerData({ uid, user, type, description, amount, stake, matchId, game = 'chess' }) {
  return {
    userId: uid,
    userName: accountName(user, uid),
    userEmail: String(user.email || ''),
    type,
    description,
    amount,
    stake,
    game,
    roundId: matchId,
    date: FieldValue.serverTimestamp(),
    status: 'completed'
  };
}

function makeMatchRecord({ mode, stake, timeMinutes = 10, whiteUid, blackUid, whiteName, blackName }) {
  const game = createChessGame();
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
    status: 'active',
    clockMs: { w: playerClockMs, b: playerClockMs },
    turnStartedAt: now,
    turnDeadlineAt: now + playerClockMs,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
}

function buildMatchView(match, uid) {
  const playerColor = colorForUid(match, uid);
  if (!playerColor) throw new HttpsError('permission-denied', 'You are not a player in this chess match.');
  const game = gameFromMatch(match);
  const opponentName = playerColor === 'w' ? match.blackName : match.whiteName;
  return {
    id: match.id,
    mode: match.mode,
    stake: match.stake,
    timeMinutes: Number(match.timeMinutes) || 10,
    status: match.status,
    fen: game.fen(),
    board: game.board().map(rank => rank.map(piece => piece ? { color: piece.color, type: piece.type } : null)),
    turn: game.turn(),
    playerColor,
    playerName: playerColor === 'w' ? match.whiteName : match.blackName,
    opponentName,
    legalMoves: match.status === 'active' && game.turn() === playerColor
      ? game.moves({ verbose: true }).map(move => ({
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {})
      }))
      : [],
    check: game.isCheck(),
    turnDeadlineAt: match.turnDeadlineAt || null,
    clockMs: match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS },
    winnerColor: match.winnerColor || null,
    won: match.status === 'completed' && match.draw !== true && (
      match.winnerUid === uid || (match.mode === 'bot' && match.winnerColor === 'w' && match.whiteUid === uid)
    ),
    draw: match.draw === true,
    result: match.result || '',
    payout: match.payouts && match.payouts[uid] ? match.payouts[uid] : 0,
    lastMove: match.moves && match.moves.length ? match.moves[match.moves.length - 1] : null
  };
}

async function getAccountSnapshots(transaction, uids) {
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  const refs = uniqueUids.map(uid => db.collection('users').doc(uid));
  const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
  return new Map(snapshots.map((snapshot, index) => [uniqueUids[index], snapshot]));
}

async function finishMatchTransaction(transaction, matchRef, match, result, finalFields = {}) {
  const players = [match.whiteUid, match.blackUid].filter(Boolean);
  const snapshots = await getAccountSnapshots(transaction, players);
  let payouts;
  try {
    payouts = calculateChessPayouts(match, result);
  } catch (error) {
    throw new HttpsError('internal', error.message);
  }
  const balanceUpdates = [];
  for (const uid of players) {
    const snapshot = snapshots.get(uid);
    if (!snapshot || !snapshot.exists) {
      throw new HttpsError('failed-precondition', 'A player account is unavailable; chess settlement needs administrator review.');
    }
    const user = snapshot.data();
    const currentBalance = Number(user.balance || 0);
    const amount = Number(payouts[uid] || 0);
    const nextBalance = currentBalance + amount;
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 || !Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(nextBalance)) {
      throw new HttpsError('failed-precondition', 'A wallet balance cannot safely accept the chess result.');
    }
    balanceUpdates.push({ uid, user, ref: snapshot.ref, amount, nextBalance });
  }

  const settledAt = FieldValue.serverTimestamp();
  for (const update of balanceUpdates) {
    const isRefund = result.draw;
    const type = isRefund ? 'game_refund' : update.amount > 0 ? 'game_payout' : 'game_loss';
    const description = isRefund
      ? 'Chess draw — stake refunded'
      : update.amount > 0
        ? 'Chess match won'
        : 'Chess match lost';
    const ledgerRef = db.collection('transactions').doc('chess_' + matchRef.id + '_' + update.uid);
    transaction.set(update.ref, { balance: update.nextBalance }, { merge: true });
    transaction.set(ledgerRef, ledgerData({
      uid: update.uid,
      user: update.user,
      type,
      description,
      amount: update.amount,
      stake: match.stake,
      matchId: matchRef.id
    }));
  }

  transaction.update(matchRef, {
    status: 'completed',
    winnerUid: result.winnerUid || null,
    winnerColor: result.winnerColor || null,
    draw: result.draw === true,
    result: result.result,
    payouts,
    completedAt: settledAt,
    updatedAt: settledAt,
    ...finalFields
  });
  for (const uid of players) {
    transaction.delete(db.collection('chessPlayers').doc(uid));
    transaction.set(db.collection('chessQueue').doc(uid), {
      status: 'complete',
      matchId: matchRef.id,
      updatedAt: settledAt
    }, { merge: true });
  }
}

function accountIsAvailable(data, stake) {
  if (!data || ['frozen', 'disabled'].includes(data.accountStatus) || data.membership?.active !== true) return false;
  const balance = Number(data.balance || 0);
  return Number.isSafeInteger(balance) && balance >= stake;
}

async function startBotMatch(request) {
  const uid = requireUid(request);
  const stake = parseStake(request.data && request.data.stake);
  const timeMinutes = parseTimeMinutes(request.data && request.data.timeMinutes, 'Chess');
  const matchRef = db.collection('chessMatches').doc();
  const stakeRef = db.collection('transactions').doc();
  const userRef = db.collection('users').doc(uid);
  const presenceRef = db.collection('chessPlayers').doc(uid);

  const outcome = await db.runTransaction(async transaction => {
    const [userSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(presenceRef)
    ]);
    if (presenceSnapshot.exists) {
      const presence = presenceSnapshot.data();
      if (presence.status === 'active' && presence.matchId) {
        return { matchId: presence.matchId, existing: true };
      }
      if (presence.status === 'waiting' && !isExpiredQueue(presence)) {
        throw new HttpsError('failed-precondition', 'Cancel your human-match queue before starting a bot game.');
      }
      transaction.delete(presenceRef);
      transaction.delete(db.collection('chessQueue').doc(uid));
    }

    const user = userSnapshot.exists ? userSnapshot.data() : null;
    const balance = validateAccount(user, stake);
    const match = makeMatchRecord({
      mode: 'bot',
      stake,
      timeMinutes,
      whiteUid: uid,
      blackUid: null,
      whiteName: accountName(user, uid),
      blackName: 'Stockfish'
    });
    transaction.update(userRef, { balance: balance - stake });
    transaction.set(stakeRef, ledgerData({
      uid,
      user,
      type: 'game_stake',
      description: 'Chess vs bot stake',
      amount: -stake,
      stake,
      matchId: matchRef.id
    }));
    transaction.set(matchRef, match);
    transaction.set(presenceRef, {
      status: 'active',
      mode: 'bot',
      stake,
      timeMinutes,
      matchId: matchRef.id,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { matchId: matchRef.id, existing: false };
  });
  return { matchId: outcome.matchId, existing: outcome.existing };
}

async function joinHumanQueue(request) {
  const uid = requireUid(request);
  const stake = parseStake(request.data && request.data.stake);
  const timeMinutes = parseTimeMinutes(request.data && request.data.timeMinutes, 'Chess');
  const userRef = db.collection('users').doc(uid);
  const ownQueueRef = db.collection('chessQueue').doc(uid);
  const ownPresenceRef = db.collection('chessPlayers').doc(uid);
  const matchRef = db.collection('chessMatches').doc();
  const ownStakeRef = db.collection('transactions').doc();

  const outcome = await db.runTransaction(async transaction => {
    const [userSnapshot, ownQueueSnapshot, ownPresenceSnapshot, queueSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(ownQueueRef),
      transaction.get(ownPresenceRef),
      transaction.get(db.collection('chessQueue').where('stake', '==', stake).where('status', '==', 'waiting').limit(20))
    ]);

    if (ownPresenceSnapshot.exists) {
      const ownPresence = ownPresenceSnapshot.data();
      if (ownPresence.status === 'active' && ownPresence.matchId) {
        return { status: 'matched', matchId: ownPresence.matchId, existing: true };
      }
      if (ownPresence.status === 'waiting'
        && (Number(ownPresence.stake) !== stake || Number(ownPresence.timeMinutes || 10) !== timeMinutes)
        && !isExpiredQueue(ownPresence)) {
        throw new HttpsError('failed-precondition', 'Cancel your current queue before changing the stake or clock.');
      }
    }

    const user = userSnapshot.exists ? userSnapshot.data() : null;
    let balance;
    try {
      balance = validateAccount(user, stake);
    } catch (error) {
      if (ownPresenceSnapshot.exists || ownQueueSnapshot.exists) {
        transaction.delete(ownPresenceRef);
        transaction.delete(ownQueueRef);
      }
      return { error: error.message, code: error.code || 'failed-precondition' };
    }

    const candidateDocs = queueSnapshot.docs.filter(doc => doc.id !== uid);
    const candidateData = candidateDocs.map(doc => doc.data());
    const candidateUids = candidateDocs.map(doc => doc.id);
    const candidatePresenceRefs = candidateUids.map(candidateUid => db.collection('chessPlayers').doc(candidateUid));
    const candidateUserRefs = candidateUids.map(candidateUid => db.collection('users').doc(candidateUid));
    const candidateSnapshots = await Promise.all([
      ...candidatePresenceRefs.map(ref => transaction.get(ref)),
      ...candidateUserRefs.map(ref => transaction.get(ref))
    ]);
    const candidatePresenceSnapshots = candidateSnapshots.slice(0, candidateUids.length);
    const candidateUserSnapshots = candidateSnapshots.slice(candidateUids.length);
    const staleCandidates = [];
    let opponent = null;

    for (let index = 0; index < candidateDocs.length; index++) {
      const queue = candidateData[index];
      if (Number(queue.timeMinutes || 10) !== timeMinutes) continue;
      const presenceSnapshot = candidatePresenceSnapshots[index];
      const opponentSnapshot = candidateUserSnapshots[index];
      const isAvailable = !isExpiredQueue(queue)
        && presenceSnapshot.exists
        && presenceSnapshot.data().status === 'waiting'
        && Number(presenceSnapshot.data().stake) === stake
        && Number(presenceSnapshot.data().timeMinutes || 10) === timeMinutes
        && accountIsAvailable(opponentSnapshot.exists ? opponentSnapshot.data() : null, stake);
      if (!isAvailable) {
        staleCandidates.push(candidateUids[index]);
        continue;
      }
      opponent = {
        uid: candidateUids[index],
        queueRef: candidateDocs[index].ref,
        presenceRef: candidatePresenceRefs[index],
        userRef: candidateUserRefs[index],
        user: opponentSnapshot.data(),
        balance: Number(opponentSnapshot.data().balance)
      };
      break;
    }

    for (const staleUid of staleCandidates) {
      transaction.delete(db.collection('chessPlayers').doc(staleUid));
      transaction.set(db.collection('chessQueue').doc(staleUid), {
        status: 'expired',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    if (!opponent) {
      if (!(ownPresenceSnapshot.exists
        && ownPresenceSnapshot.data().status === 'waiting'
        && Number(ownPresenceSnapshot.data().stake) === stake
        && Number(ownPresenceSnapshot.data().timeMinutes || 10) === timeMinutes
        && !isExpiredQueue(ownPresenceSnapshot.data()))) {
        transaction.set(ownQueueRef, {
          uid,
          stake,
          timeMinutes,
          status: 'waiting',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(ownPresenceRef, {
          status: 'waiting',
          mode: 'human',
          stake,
          timeMinutes,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return { status: 'waiting', stake };
    }

    const opponentQueueSnapshot = candidateDocs[candidateUids.indexOf(opponent.uid)];
    const opponentQueueData = opponentQueueSnapshot.data();
    const opponentStakeRef = db.collection('transactions').doc();
    const white = randomInt(0, 2) === 0
      ? { uid, user, balance, queueRef: ownQueueRef, presenceRef: ownPresenceRef, stakeRef: ownStakeRef }
      : { uid: opponent.uid, user: opponent.user, balance: opponent.balance, queueRef: opponent.queueRef, presenceRef: opponent.presenceRef, stakeRef: opponentStakeRef };
    const black = white.uid === uid
      ? { uid: opponent.uid, user: opponent.user, balance: opponent.balance, queueRef: opponent.queueRef, presenceRef: opponent.presenceRef, stakeRef: opponentStakeRef }
      : { uid, user, balance, queueRef: ownQueueRef, presenceRef: ownPresenceRef, stakeRef: ownStakeRef };
    const match = makeMatchRecord({
      mode: 'human',
      stake,
      timeMinutes,
      whiteUid: white.uid,
      blackUid: black.uid,
      whiteName: accountName(white.user, white.uid),
      blackName: accountName(black.user, black.uid)
    });

    transaction.update(userRef, { balance: balance - stake });
    transaction.update(opponent.userRef, { balance: opponent.balance - stake });
    for (const player of [white, black]) {
      transaction.set(player.stakeRef, ledgerData({
        uid: player.uid,
        user: player.user,
        type: 'game_stake',
        description: 'Chess human match stake',
        amount: -stake,
        stake,
        matchId: matchRef.id
      }));
      transaction.set(player.queueRef, {
        uid: player.uid,
        stake,
        timeMinutes,
        status: 'matched',
        matchId: matchRef.id,
        createdAt: opponentQueueData.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.set(player.presenceRef, {
        status: 'active',
        mode: 'human',
        stake,
        timeMinutes,
        matchId: matchRef.id,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    transaction.set(matchRef, match);
    return { status: 'matched', matchId: matchRef.id, existing: false };
  });

  if (outcome.error) throw new HttpsError(outcome.code, outcome.error);
  return outcome;
}

async function queueStatus(request) {
  const uid = requireUid(request);
  const presenceRef = db.collection('chessPlayers').doc(uid);
  const queueRef = db.collection('chessQueue').doc(uid);
  return db.runTransaction(async transaction => {
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(presenceRef)
    ]);
    if (!presenceSnapshot.exists) return { status: 'idle' };
    const presence = presenceSnapshot.data();
    if (presence.status === 'active' && presence.matchId) {
      return { status: 'matched', matchId: presence.matchId };
    }
    if (!queueSnapshot.exists || presence.status !== 'waiting') return { status: 'idle' };
    if (isExpiredQueue(queueSnapshot.data())) {
      transaction.delete(queueRef);
      transaction.delete(presenceRef);
      return { status: 'expired' };
    }
    return {
      status: 'waiting',
      stake: Number(presence.stake),
      timeMinutes: Number(presence.timeMinutes) || 10
    };
  });
}

async function cancelHumanQueue(request) {
  const uid = requireUid(request);
  const queueRef = db.collection('chessQueue').doc(uid);
  const presenceRef = db.collection('chessPlayers').doc(uid);
  const result = await db.runTransaction(async transaction => {
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(presenceRef)
    ]);
    if (presenceSnapshot.exists && presenceSnapshot.data().status === 'active') {
      return { status: 'active', matchId: presenceSnapshot.data().matchId || null };
    }
    if (queueSnapshot.exists) transaction.delete(queueRef);
    if (presenceSnapshot.exists) transaction.delete(presenceRef);
    return { status: 'cancelled' };
  });
  if (result.status === 'active') {
    throw new HttpsError('failed-precondition', 'This request has already matched. Resign from the match if you want to end it.');
  }
  return result;
}

async function settleTimeout(matchRef) {
  return db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
    const match = matchSnapshot.data();
    if (match.status !== 'active' || Number(match.turnDeadlineAt || 0) > Date.now()) return match;
    const game = gameFromMatch(match);
    const timedOutColor = game.turn();
    const winnerColor = timedOutColor === 'w' ? 'b' : 'w';
    const winnerUid = winnerColor === 'w' ? match.whiteUid : match.blackUid;
    const result = { draw: false, winnerColor, winnerUid, result: 'Time expired — opponent wins' };
    await finishMatchTransaction(transaction, matchRef, match, result);
    return { ...match, status: 'completed', winnerUid, winnerColor, draw: false, result: result.result };
  });
}

async function applyBotMove(matchRef) {
  const token = randomUUID();
  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(matchRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
    const match = snapshot.data();
    if (match.status !== 'active' || match.mode !== 'bot') return null;
    const game = gameFromMatch(match);
    if (game.turn() !== 'b') return null;
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) return { expired: true };
    if (match.botThinkingAt && Date.now() - Number(match.botThinkingAt) < 60000) return null;
    transaction.update(matchRef, { botThinkingAt: Date.now(), botThinkingToken: token });
    return { fen: game.fen() };
  });
  if (!claim) return;
  if (claim.expired) {
    await settleTimeout(matchRef);
    return;
  }

  let uci;
  try {
    uci = await findBestMove(claim.fen);
  } catch (error) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(matchRef);
      if (snapshot.exists && snapshot.data().botThinkingToken === token) {
        transaction.update(matchRef, { botThinkingAt: null, botThinkingToken: null });
      }
    });
    throw error;
  }
  if (!uci) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(matchRef);
      if (snapshot.exists && snapshot.data().botThinkingToken === token) {
        transaction.update(matchRef, { botThinkingAt: null, botThinkingToken: null });
      }
    });
    throw new HttpsError('internal', 'The chess engine did not return a move.');
  }
  const engineMove = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] } : {})
  };

  await db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
    const match = matchSnapshot.data();
    if (match.status !== 'active' || match.mode !== 'bot' || match.botThinkingToken !== token) return;
    const game = gameFromMatch(match);
    if (game.turn() !== 'b' || game.fen() !== claim.fen) return;

    const applied = applyChessMove(game, engineMove);
    if (!applied) throw new HttpsError('internal', 'The chess engine returned an illegal move.');
    const moves = [...(match.moves || []), {
      from: applied.from,
      to: applied.to,
      ...(applied.promotion ? { promotion: applied.promotion } : {}),
      san: applied.san,
      color: applied.color
    }];
    const outcome = getChessOutcome(game);
    if (outcome) {
      const result = {
        draw: outcome.draw,
        winnerColor: outcome.winnerColor,
        winnerUid: outcome.winnerColor === 'w' ? match.whiteUid : outcome.winnerColor === 'b' ? match.blackUid : null,
        result: outcome.result
      };
      await finishMatchTransaction(transaction, matchRef, match, result, {
        moves,
        fen: game.fen(),
        botThinkingAt: null,
        botThinkingToken: null
      });
      return;
    }
    const now = Date.now();
    const clockMs = { ...(match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS }) };
    clockMs.b = Math.max(0, clockMs.b - (now - Number(match.turnStartedAt || now)));
    if (clockMs.b === 0) {
      await finishMatchTransaction(transaction, matchRef, match, {
        draw: false,
        winnerUid: match.whiteUid,
        winnerColor: 'w',
        result: 'Stockfish ran out of time'
      }, { moves, fen: game.fen(), clockMs, botThinkingAt: null, botThinkingToken: null });
      return;
    }
    transaction.update(matchRef, {
      moves,
      fen: game.fen(),
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + clockMs.w,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

async function getMatch(request) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid chess match ID is required.');
  }
  const matchRef = db.collection('chessMatches').doc(matchId);
  let matchSnapshot = await matchRef.get();
  if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
  let match = { id: matchSnapshot.id, ...matchSnapshot.data() };
  if (!colorForUid(match, uid)) throw new HttpsError('permission-denied', 'You are not a player in this chess match.');
  if (match.status === 'active' && Number(match.turnDeadlineAt || 0) <= Date.now()) {
    await settleTimeout(matchRef);
    matchSnapshot = await matchRef.get();
    match = { id: matchSnapshot.id, ...matchSnapshot.data() };
  } else if (match.status === 'active' && match.mode === 'bot') {
    const game = gameFromMatch(match);
    if (game.turn() === 'b') {
      await applyBotMove(matchRef);
      matchSnapshot = await matchRef.get();
      match = { id: matchSnapshot.id, ...matchSnapshot.data() };
    }
  }
  return buildMatchView(match, uid);
}

async function playMove(request) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid chess match ID is required.');
  }
  const matchRef = db.collection('chessMatches').doc(matchId);
  const moveInput = {
    from: request.data && request.data.from,
    to: request.data && request.data.to,
    promotion: request.data && request.data.promotion
  };

  await db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
    const match = matchSnapshot.data();
    if (!colorForUid(match, uid)) throw new HttpsError('permission-denied', 'You are not a player in this chess match.');
    if (match.status !== 'active') throw new HttpsError('failed-precondition', 'This chess match has already ended.');
    const game = gameFromMatch(match);
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) {
      const timedOutColor = game.turn();
      const winnerUid = timedOutColor === 'w' ? match.blackUid : match.whiteUid;
      await finishMatchTransaction(transaction, matchRef, match, {
        draw: false,
        winnerUid,
        winnerColor: timedOutColor === 'w' ? 'b' : 'w',
        result: 'Time expired — opponent wins'
      });
      return;
    }
    if (colorForUid(match, uid) !== game.turn()) {
      throw new HttpsError('failed-precondition', 'Wait for your turn before moving.');
    }
    let applied;
    try {
      applied = applyChessMove(game, moveInput);
    } catch (error) {
      throw new HttpsError('invalid-argument', error.message || 'That is not a legal chess move.');
    }
    if (!applied) throw new HttpsError('invalid-argument', 'That is not a legal chess move.');
    const moves = [...(match.moves || []), {
      from: applied.from,
      to: applied.to,
      ...(applied.promotion ? { promotion: applied.promotion } : {}),
      san: applied.san,
      color: applied.color
    }];
    const outcome = getChessOutcome(game);
    if (outcome) {
      const result = {
        draw: outcome.draw,
        winnerColor: outcome.winnerColor,
        winnerUid: outcome.winnerColor === 'w' ? match.whiteUid : outcome.winnerColor === 'b' ? match.blackUid : null,
        result: outcome.result
      };
      await finishMatchTransaction(transaction, matchRef, match, result, { moves, fen: game.fen() });
      return;
    }
    const now = Date.now();
    const clockMs = { ...(match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS }) };
    clockMs[applied.color] = Math.max(0, clockMs[applied.color] - (now - Number(match.turnStartedAt || now)));
    if (clockMs[applied.color] === 0) {
      await finishMatchTransaction(transaction, matchRef, match, {
        draw: false,
        winnerUid: applied.color === 'w' ? match.blackUid : match.whiteUid,
        winnerColor: applied.color === 'w' ? 'b' : 'w',
        result: 'Time expired — opponent wins'
      }, { moves, fen: game.fen(), clockMs });
      return;
    }
    transaction.update(matchRef, {
      moves,
      fen: game.fen(),
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + clockMs[game.turn()],
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  const latest = await matchRef.get();
  if (latest.exists && latest.data().status === 'active' && latest.data().mode === 'bot') {
    await applyBotMove(matchRef);
  }
  const finalSnapshot = await matchRef.get();
  if (!finalSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
  return buildMatchView({ id: finalSnapshot.id, ...finalSnapshot.data() }, uid);
}

async function resignMatch(request) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid chess match ID is required.');
  }
  const matchRef = db.collection('chessMatches').doc(matchId);
  await db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Chess match not found.');
    const match = matchSnapshot.data();
    const color = colorForUid(match, uid);
    if (!color) throw new HttpsError('permission-denied', 'You are not a player in this chess match.');
    if (match.status !== 'active') return;
    const winnerUid = color === 'w' ? match.blackUid : match.whiteUid;
    await finishMatchTransaction(transaction, matchRef, match, {
      draw: false,
      winnerUid,
      winnerColor: color === 'w' ? 'b' : 'w',
      result: 'Resignation'
    });
  });
  return getMatch({ auth: request.auth, data: { matchId } });
}

async function getCurrentGame(request) {
  const uid = requireUid(request);
  const presenceSnapshot = await db.collection('chessPlayers').doc(uid).get();
  if (!presenceSnapshot.exists) return { status: 'idle' };
  const presence = presenceSnapshot.data();
  if (presence.status === 'waiting') {
    return {
      status: 'waiting',
      stake: Number(presence.stake),
      timeMinutes: Number(presence.timeMinutes) || 10
    };
  }
  if (presence.status !== 'active' || !presence.matchId) return { status: 'idle' };
  return getMatch({ auth: request.auth, data: { matchId: presence.matchId } });
}

function whotColorForUid(match, uid) {
  if (match.whiteUid === uid) return 'w';
  if (match.blackUid === uid) return 'b';
  return null;
}

function makeWhotMatchRecord({ mode, stake, timeMinutes = 10, whiteUid, blackUid, whiteName, blackName }) {
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
    status: 'active',
    clockMs: { w: turnTimeMs, b: turnTimeMs },
    turnStartedAt: now,
    turnDeadlineAt: now + turnTimeMs,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
}

function buildWhotMatchView(match, uid) {
  const playerColor = whotColorForUid(match, uid);
  if (!playerColor) throw new HttpsError('permission-denied', 'You are not a player in this Whot match.');
  const game = match.gameState;
  const opponentColor = playerColor === 'w' ? 'b' : 'w';
  const hand = game.hands[playerColor];
  return {
    id: match.id,
    mode: match.mode,
    stake: match.stake,
    timeMinutes: Number(match.timeMinutes) || 10,
    turnTimeMs: whotTurnTimeMs(match),
    status: match.status,
    playerColor,
    playerName: playerColor === 'w' ? match.whiteName : match.blackName,
    opponentName: playerColor === 'w' ? match.blackName : match.whiteName,
    hand,
    opponentCardCount: game.hands[opponentColor].length,
    topCard: game.discard[game.discard.length - 1],
    marketCount: game.market.length,
    currentPlayer: game.currentPlayer,
    legalCardIds: match.status === 'active' && game.currentPlayer === playerColor
      ? legalWhotCards(game, playerColor).map(card => card.id)
      : [],
    pendingDraw: game.pendingDraw,
    requestedSuit: game.requestedSuit,
    lastAction: game.lastAction,
    turnDeadlineAt: match.turnDeadlineAt || null,
    clockMs: match.clockMs || { w: PLAYER_CLOCK_MS, b: PLAYER_CLOCK_MS },
    winnerColor: match.winnerColor || null,
    won: match.status === 'completed' && match.draw !== true && (
      match.winnerUid === uid || (match.mode === 'bot' && match.winnerColor === 'w' && match.whiteUid === uid)
    ),
    draw: match.draw === true,
    result: match.result || '',
    payout: match.payouts && match.payouts[uid] ? match.payouts[uid] : 0
  };
}

async function finishWhotTransaction(transaction, matchRef, match, result, finalFields = {}) {
  const players = [match.whiteUid, match.blackUid].filter(Boolean);
  const snapshots = await getAccountSnapshots(transaction, players);
  let payouts;
  try {
    payouts = calculateWhotPayouts(match, result);
  } catch (error) {
    throw new HttpsError('internal', error.message);
  }
  const balanceUpdates = [];
  for (const uid of players) {
    const snapshot = snapshots.get(uid);
    if (!snapshot || !snapshot.exists) {
      throw new HttpsError('failed-precondition', 'A player account is unavailable; Whot settlement needs administrator review.');
    }
    const user = snapshot.data();
    const currentBalance = Number(user.balance || 0);
    const amount = Number(payouts[uid] || 0);
    const nextBalance = currentBalance + amount;
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 || !Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(nextBalance)) {
      throw new HttpsError('failed-precondition', 'A wallet balance cannot safely accept the Whot result.');
    }
    balanceUpdates.push({ uid, user, ref: snapshot.ref, amount, nextBalance });
  }

  const settledAt = FieldValue.serverTimestamp();
  for (const update of balanceUpdates) {
    const isRefund = result.draw === true;
    const type = isRefund ? 'game_refund' : update.amount > 0 ? 'game_payout' : 'game_loss';
    const description = isRefund
      ? 'Whot draw — stake refunded'
      : update.amount > 0
        ? 'Whot match won'
        : 'Whot match lost';
    const ledgerRef = db.collection('transactions').doc('whot_' + matchRef.id + '_' + update.uid);
    transaction.set(update.ref, { balance: update.nextBalance }, { merge: true });
    transaction.set(ledgerRef, ledgerData({
      uid: update.uid,
      user: update.user,
      type,
      description,
      amount: update.amount,
      stake: match.stake,
      matchId: matchRef.id,
      game: 'whot'
    }));
  }

  transaction.update(matchRef, {
    status: 'completed',
    winnerUid: result.winnerUid || null,
    winnerColor: result.winnerColor || null,
    draw: result.draw === true,
    result: result.result,
    payouts,
    completedAt: settledAt,
    updatedAt: settledAt,
    ...finalFields
  });
  for (const uid of players) {
    transaction.delete(db.collection('whotPlayers').doc(uid));
    transaction.set(db.collection('whotQueue').doc(uid), {
      status: 'complete',
      matchId: matchRef.id,
      updatedAt: settledAt
    }, { merge: true });
  }
}

async function startWhotBot(request) {
  const uid = requireUid(request);
  const stake = parseStake(request.data && request.data.stake);
  const timeMinutes = parseTimeMinutes(request.data && request.data.timeMinutes, 'Whot');
  const matchRef = db.collection('whotMatches').doc();
  const stakeRef = db.collection('transactions').doc();
  const userRef = db.collection('users').doc(uid);
  const presenceRef = db.collection('whotPlayers').doc(uid);
  const queueRef = db.collection('whotQueue').doc(uid);

  const outcome = await db.runTransaction(async transaction => {
    const [userSnapshot, presenceSnapshot, queueSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(presenceRef),
      transaction.get(queueRef)
    ]);
    if (presenceSnapshot.exists) {
      const presence = presenceSnapshot.data();
      if (presence.status === 'active' && presence.matchId) {
        return { matchId: presence.matchId, existing: true };
      }
      if (presence.status === 'waiting' && queueSnapshot.exists && !isExpiredQueue(queueSnapshot.data())) {
        throw new HttpsError('failed-precondition', 'Cancel Whot matchmaking before starting a bot game.');
      }
      transaction.delete(presenceRef);
      transaction.delete(queueRef);
    }

    const user = userSnapshot.exists ? userSnapshot.data() : null;
    const balance = validateAccount(user, stake);
    const match = makeWhotMatchRecord({
      mode: 'bot',
      stake,
      timeMinutes,
      whiteUid: uid,
      blackUid: null,
      whiteName: accountName(user, uid),
      blackName: 'Whot Bot'
    });
    transaction.update(userRef, { balance: balance - stake });
    transaction.set(stakeRef, ledgerData({
      uid,
      user,
      type: 'game_stake',
      description: 'Whot vs bot stake',
      amount: -stake,
      stake,
      matchId: matchRef.id,
      game: 'whot'
    }));
    transaction.set(matchRef, match);
    transaction.set(presenceRef, {
      status: 'active',
      mode: 'bot',
      stake,
      timeMinutes,
      matchId: matchRef.id,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { matchId: matchRef.id, existing: false };
  });
  return { matchId: outcome.matchId, existing: outcome.existing };
}

async function joinWhotQueue(request) {
  const uid = requireUid(request);
  const stake = parseStake(request.data && request.data.stake);
  const timeMinutes = parseTimeMinutes(request.data && request.data.timeMinutes, 'Whot');
  const userRef = db.collection('users').doc(uid);
  const ownQueueRef = db.collection('whotQueue').doc(uid);
  const ownPresenceRef = db.collection('whotPlayers').doc(uid);
  const matchRef = db.collection('whotMatches').doc();
  const ownStakeRef = db.collection('transactions').doc();

  const outcome = await db.runTransaction(async transaction => {
    const [userSnapshot, ownQueueSnapshot, ownPresenceSnapshot, queueSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(ownQueueRef),
      transaction.get(ownPresenceRef),
      transaction.get(db.collection('whotQueue').where('stake', '==', stake).where('status', '==', 'waiting').limit(20))
    ]);
    if (ownPresenceSnapshot.exists) {
      const presence = ownPresenceSnapshot.data();
      if (presence.status === 'active' && presence.matchId) {
        return { status: 'matched', matchId: presence.matchId, existing: true };
      }
      if (presence.status === 'waiting'
        && (Number(presence.stake) !== stake || Number(presence.timeMinutes || 10) !== timeMinutes)
        && ownQueueSnapshot.exists
        && !isExpiredQueue(ownQueueSnapshot.data())) {
        throw new HttpsError('failed-precondition', 'Cancel your current Whot queue before changing the stake or turn time.');
      }
    }

    const user = userSnapshot.exists ? userSnapshot.data() : null;
    const balance = validateAccount(user, stake);
    const candidateDocs = queueSnapshot.docs.filter(doc => doc.id !== uid);
    const candidateUids = candidateDocs.map(doc => doc.id);
    const candidateRefs = candidateUids.map(candidateUid => ({
      presence: db.collection('whotPlayers').doc(candidateUid),
      user: db.collection('users').doc(candidateUid)
    }));
    const candidateSnapshots = await Promise.all(candidateRefs.flatMap(refs => [
      transaction.get(refs.presence),
      transaction.get(refs.user)
    ]));
    let opponent = null;
    const staleUids = [];
    for (let index = 0; index < candidateDocs.length; index++) {
      const presenceSnapshot = candidateSnapshots[index * 2];
      const opponentSnapshot = candidateSnapshots[index * 2 + 1];
      const queue = candidateDocs[index].data();
      if (Number(queue.timeMinutes || 10) !== timeMinutes) continue;
      const available = !isExpiredQueue(queue)
        && presenceSnapshot.exists
        && presenceSnapshot.data().status === 'waiting'
        && Number(presenceSnapshot.data().stake) === stake
        && Number(presenceSnapshot.data().timeMinutes || 10) === timeMinutes
        && accountIsAvailable(opponentSnapshot.exists ? opponentSnapshot.data() : null, stake);
      if (!available) {
        staleUids.push(candidateUids[index]);
        continue;
      }
      opponent = {
        uid: candidateUids[index],
        queueRef: candidateDocs[index].ref,
        presenceRef: candidateRefs[index].presence,
        userRef: candidateRefs[index].user,
        user: opponentSnapshot.data(),
        balance: Number(opponentSnapshot.data().balance)
      };
      break;
    }

    for (const staleUid of staleUids) {
      transaction.delete(db.collection('whotPlayers').doc(staleUid));
      transaction.set(db.collection('whotQueue').doc(staleUid), {
        status: 'expired',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    if (!opponent) {
      const ownPresence = ownPresenceSnapshot.exists ? ownPresenceSnapshot.data() : null;
      if (!(ownPresence && ownPresence.status === 'waiting'
        && Number(ownPresence.stake) === stake
        && Number(ownPresence.timeMinutes || 10) === timeMinutes
        && ownQueueSnapshot.exists
        && !isExpiredQueue(ownQueueSnapshot.data()))) {
        transaction.set(ownQueueRef, {
          uid,
          stake,
          timeMinutes,
          status: 'waiting',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(ownPresenceRef, {
          status: 'waiting',
          mode: 'human',
          stake,
          timeMinutes,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return { status: 'waiting', stake };
    }

    const opponentQueueData = candidateDocs[candidateUids.indexOf(opponent.uid)].data();
    const opponentStakeRef = db.collection('transactions').doc();
    const white = randomInt(0, 2) === 0
      ? { uid, user, balance, queueRef: ownQueueRef, presenceRef: ownPresenceRef, stakeRef: ownStakeRef }
      : { uid: opponent.uid, user: opponent.user, balance: opponent.balance, queueRef: opponent.queueRef, presenceRef: opponent.presenceRef, stakeRef: opponentStakeRef };
    const black = white.uid === uid
      ? { uid: opponent.uid, user: opponent.user, balance: opponent.balance, queueRef: opponent.queueRef, presenceRef: opponent.presenceRef, stakeRef: opponentStakeRef }
      : { uid, user, balance, queueRef: ownQueueRef, presenceRef: ownPresenceRef, stakeRef: ownStakeRef };
    const match = makeWhotMatchRecord({
      mode: 'human',
      stake,
      timeMinutes,
      whiteUid: white.uid,
      blackUid: black.uid,
      whiteName: accountName(white.user, white.uid),
      blackName: accountName(black.user, black.uid)
    });

    transaction.update(userRef, { balance: balance - stake });
    transaction.update(opponent.userRef, { balance: opponent.balance - stake });
    for (const player of [white, black]) {
      transaction.set(player.stakeRef, ledgerData({
        uid: player.uid,
        user: player.user,
        type: 'game_stake',
        description: 'Whot human match stake',
        amount: -stake,
        stake,
        matchId: matchRef.id,
        game: 'whot'
      }));
      transaction.set(player.queueRef, {
        uid: player.uid,
        stake,
        timeMinutes,
        status: 'matched',
        matchId: matchRef.id,
        createdAt: opponentQueueData.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.set(player.presenceRef, {
        status: 'active',
        mode: 'human',
        stake,
        timeMinutes,
        matchId: matchRef.id,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    transaction.set(matchRef, match);
    return { status: 'matched', matchId: matchRef.id, existing: false };
  });
  return outcome;
}

async function whotQueueStatus(request) {
  const uid = requireUid(request);
  const presenceRef = db.collection('whotPlayers').doc(uid);
  const queueRef = db.collection('whotQueue').doc(uid);
  return db.runTransaction(async transaction => {
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(presenceRef)
    ]);
    if (!presenceSnapshot.exists) return { status: 'idle' };
    const presence = presenceSnapshot.data();
    if (presence.status === 'active' && presence.matchId) {
      return { status: 'matched', matchId: presence.matchId };
    }
    if (!queueSnapshot.exists || presence.status !== 'waiting') return { status: 'idle' };
    if (isExpiredQueue(queueSnapshot.data())) {
      transaction.delete(queueRef);
      transaction.delete(presenceRef);
      return { status: 'expired' };
    }
    return {
      status: 'waiting',
      stake: Number(presence.stake),
      timeMinutes: Number(presence.timeMinutes) || 10
    };
  });
}

async function cancelWhotQueue(request) {
  const uid = requireUid(request);
  const queueRef = db.collection('whotQueue').doc(uid);
  const presenceRef = db.collection('whotPlayers').doc(uid);
  const result = await db.runTransaction(async transaction => {
    const [queueSnapshot, presenceSnapshot] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(presenceRef)
    ]);
    if (presenceSnapshot.exists && presenceSnapshot.data().status === 'active') {
      return { status: 'active' };
    }
    if (queueSnapshot.exists) transaction.delete(queueRef);
    if (presenceSnapshot.exists) transaction.delete(presenceRef);
    return { status: 'cancelled' };
  });
  if (result.status === 'active') {
    throw new HttpsError('failed-precondition', 'This Whot request has already matched. Resign from the match if you want to end it.');
  }
  return result;
}

async function settleWhotTimeout(matchRef) {
  return db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
    const match = matchSnapshot.data();
    if (match.status !== 'active' || Number(match.turnDeadlineAt || 0) > Date.now()) return match;
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const gameState = passWhotTurn(match.gameState);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    transaction.update(matchRef, {
      gameState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { ...match, gameState, clockMs, turnStartedAt: now, turnDeadlineAt: now + turnTimeMs };
  });
}

async function applyWhotBotMove(matchRef) {
  const token = randomUUID();
  const claim = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(matchRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
    const match = snapshot.data();
    if (match.status !== 'active' || match.mode !== 'bot' || match.gameState.currentPlayer !== 'b') return null;
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) return { expired: true };
    if (match.botThinkingAt && Date.now() - Number(match.botThinkingAt) < 30000) return null;
    transaction.update(matchRef, { botThinkingAt: Date.now(), botThinkingToken: token });
    return { gameState: match.gameState };
  });
  if (!claim) return;
  if (claim.expired) {
    await settleWhotTimeout(matchRef);
    return;
  }

  let action;
  try {
    action = chooseWhotAction(claim.gameState, 'b');
  } catch (error) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(matchRef);
      if (snapshot.exists && snapshot.data().botThinkingToken === token) {
        transaction.update(matchRef, { botThinkingAt: null, botThinkingToken: null });
      }
    });
    throw error;
  }

  const continueBotTurn = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(matchRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
    const match = snapshot.data();
    if (match.status !== 'active' || match.mode !== 'bot' || match.botThinkingToken !== token) return false;
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    if (Number(match.turnDeadlineAt || 0) <= now) {
      const nextState = passWhotTurn(match.gameState);
      transaction.update(matchRef, {
        gameState: nextState,
        clockMs,
        turnStartedAt: now,
        turnDeadlineAt: now + turnTimeMs,
        botThinkingAt: null,
        botThinkingToken: null,
        updatedAt: FieldValue.serverTimestamp()
      });
      return false;
    }

    let nextState;
    try {
      nextState = applyWhotAction(match.gameState, 'b', action);
    } catch (error) {
      throw new HttpsError('internal', error.message);
    }
    const outcome = getWhotOutcome(nextState);
    if (outcome) {
      const winnerUid = outcome.winnerColor === 'w' ? match.whiteUid : outcome.winnerColor === 'b' ? match.blackUid : null;
      await finishWhotTransaction(transaction, matchRef, match, {
        draw: outcome.draw,
        winnerColor: outcome.winnerColor,
        winnerUid,
        result: outcome.result
      }, { gameState: nextState, clockMs, botThinkingAt: null, botThinkingToken: null });
      return false;
    }
    transaction.update(matchRef, {
      gameState: nextState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: FieldValue.serverTimestamp()
    });
    return nextState.currentPlayer === 'b';
  });
  if (continueBotTurn) await applyWhotBotMove(matchRef);
}

async function getWhotMatch(request) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid Whot match ID is required.');
  }
  const matchRef = db.collection('whotMatches').doc(matchId);
  let matchSnapshot = await matchRef.get();
  if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
  let match = { id: matchSnapshot.id, ...matchSnapshot.data() };
  if (!whotColorForUid(match, uid)) throw new HttpsError('permission-denied', 'You are not a player in this Whot match.');
  if (match.status === 'active' && Number(match.turnDeadlineAt || 0) <= Date.now()) {
    await settleWhotTimeout(matchRef);
    matchSnapshot = await matchRef.get();
    match = { id: matchSnapshot.id, ...matchSnapshot.data() };
  }
  if (match.status === 'active' && match.mode === 'bot' && match.gameState.currentPlayer === 'b') {
    await applyWhotBotMove(matchRef);
    matchSnapshot = await matchRef.get();
    match = { id: matchSnapshot.id, ...matchSnapshot.data() };
  }
  return buildWhotMatchView(match, uid);
}

async function commitWhotAction(request, action) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid Whot match ID is required.');
  }
  const matchRef = db.collection('whotMatches').doc(matchId);
  await db.runTransaction(async transaction => {
    const matchSnapshot = await transaction.get(matchRef);
    if (!matchSnapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
    const match = matchSnapshot.data();
    const color = whotColorForUid(match, uid);
    if (!color) throw new HttpsError('permission-denied', 'You are not a player in this Whot match.');
    if (match.status !== 'active') throw new HttpsError('failed-precondition', 'This Whot match has already ended.');
    const now = Date.now();
    const turnTimeMs = whotTurnTimeMs(match);
    const clockMs = { w: turnTimeMs, b: turnTimeMs };
    let turnState = match.gameState;
    if (Number(match.turnDeadlineAt || 0) <= now) {
      turnState = passWhotTurn(match.gameState);
      if (color !== turnState.currentPlayer) {
        transaction.update(matchRef, {
          gameState: turnState,
          clockMs,
          turnStartedAt: now,
          turnDeadlineAt: now + turnTimeMs,
          botThinkingAt: null,
          botThinkingToken: null,
          updatedAt: FieldValue.serverTimestamp()
        });
        return;
      }
    }
    if (color !== turnState.currentPlayer) {
      throw new HttpsError('failed-precondition', 'Wait for your turn before playing.');
    }

    let gameState;
    try {
      gameState = applyWhotAction(turnState, color, action);
    } catch (error) {
      throw new HttpsError('invalid-argument', error.message);
    }
    const outcome = getWhotOutcome(gameState);
    if (outcome) {
      const winnerUid = outcome.winnerColor === 'w' ? match.whiteUid : outcome.winnerColor === 'b' ? match.blackUid : null;
      await finishWhotTransaction(transaction, matchRef, match, {
        draw: outcome.draw,
        winnerColor: outcome.winnerColor,
        winnerUid,
        result: outcome.result
      }, { gameState, clockMs });
      return;
    }
    transaction.update(matchRef, {
      gameState,
      clockMs,
      turnStartedAt: now,
      turnDeadlineAt: now + turnTimeMs,
      botThinkingAt: null,
      botThinkingToken: null,
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  let latest = await matchRef.get();
  if (latest.exists && latest.data().status === 'active' && latest.data().mode === 'bot' && latest.data().gameState.currentPlayer === 'b') {
    await applyWhotBotMove(matchRef);
  }
  latest = await matchRef.get();
  if (!latest.exists) throw new HttpsError('not-found', 'Whot match not found.');
  return buildWhotMatchView({ id: latest.id, ...latest.data() }, uid);
}

async function playWhotCard(request) {
  return commitWhotAction(request, {
    type: 'play',
    cardId: request.data && request.data.cardId,
    requestedSuit: request.data && request.data.requestedSuit
  });
}

async function drawWhotCard(request) {
  return commitWhotAction(request, { type: 'draw' });
}

async function resignWhotMatch(request) {
  const uid = requireUid(request);
  const matchId = String(request.data && request.data.matchId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) {
    throw new HttpsError('invalid-argument', 'A valid Whot match ID is required.');
  }
  const matchRef = db.collection('whotMatches').doc(matchId);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(matchRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Whot match not found.');
    const match = snapshot.data();
    const color = whotColorForUid(match, uid);
    if (!color) throw new HttpsError('permission-denied', 'You are not a player in this Whot match.');
    if (match.status !== 'active') return;
    const winnerColor = color === 'w' ? 'b' : 'w';
    const winnerUid = winnerColor === 'w' ? match.whiteUid : match.blackUid;
    await finishWhotTransaction(transaction, matchRef, match, {
      draw: false,
      winnerColor,
      winnerUid,
      result: 'Resignation'
    });
  });
  return getWhotMatch({ auth: request.auth, data: { matchId } });
}

async function getCurrentWhotGame(request) {
  const uid = requireUid(request);
  const presenceSnapshot = await db.collection('whotPlayers').doc(uid).get();
  if (!presenceSnapshot.exists) return { status: 'idle' };
  const presence = presenceSnapshot.data();
  if (presence.status === 'waiting') {
    return {
      status: 'waiting',
      stake: Number(presence.stake),
      timeMinutes: Number(presence.timeMinutes) || 10
    };
  }
  if (presence.status !== 'active' || !presence.matchId) return { status: 'idle' };
  return getWhotMatch({ auth: request.auth, data: { matchId: presence.matchId } });
}

exports.whotStartBot = onCall({ timeoutSeconds: 30 }, startWhotBot);
exports.whotJoinQueue = onCall({ timeoutSeconds: 30 }, joinWhotQueue);
exports.whotQueueStatus = onCall({ timeoutSeconds: 30 }, whotQueueStatus);
exports.whotCancelQueue = onCall({ timeoutSeconds: 30 }, cancelWhotQueue);
exports.whotGetCurrent = onCall({ timeoutSeconds: 120, memory: '512MiB' }, getCurrentWhotGame);
exports.whotGetMatch = onCall({ timeoutSeconds: 120, memory: '512MiB' }, getWhotMatch);
exports.whotPlay = onCall({ timeoutSeconds: 30 }, playWhotCard);
exports.whotDraw = onCall({ timeoutSeconds: 30 }, drawWhotCard);
exports.whotResign = onCall({ timeoutSeconds: 30 }, resignWhotMatch);

exports.walletTransfer = onCall({ timeoutSeconds: 30 }, transferWallet);
exports.walletSetTransferPin = onCall({ timeoutSeconds: 30 }, setTransferPin);
exports.adminAdjustWallet = onCall({ timeoutSeconds: 30 }, adjustWalletAsAdmin);
exports.claimDailyEarning = onCall({ timeoutSeconds: 30 }, claimDailyEarning);
exports.claimDailyCheckin = onCall({ timeoutSeconds: 30 }, claimDailyCheckin);

exports.chessStartBot = onCall({ timeoutSeconds: 30 }, startBotMatch);
exports.chessJoinQueue = onCall({ timeoutSeconds: 30 }, joinHumanQueue);
exports.chessQueueStatus = onCall({ timeoutSeconds: 30 }, queueStatus);
exports.chessCancelQueue = onCall({ timeoutSeconds: 30 }, cancelHumanQueue);
exports.chessGetCurrent = onCall({ timeoutSeconds: 120, memory: '512MiB' }, getCurrentGame);
exports.chessGetMatch = onCall({ timeoutSeconds: 120, memory: '512MiB' }, getMatch);
exports.chessMove = onCall({ timeoutSeconds: 120, memory: '512MiB' }, playMove);
exports.chessResign = onCall({ timeoutSeconds: 30 }, resignMatch);
exports.chessSweepTimeouts = onSchedule('every 1 minutes', async () => {
  const [matches, queues, whotMatches, whotQueues] = await Promise.all([
    db.collection('chessMatches').where('status', '==', 'active').limit(200).get(),
    db.collection('chessQueue').where('status', '==', 'waiting').limit(200).get(),
    db.collection('whotMatches').where('status', '==', 'active').limit(200).get(),
    db.collection('whotQueue').where('status', '==', 'waiting').limit(200).get()
  ]);
  const failures = [];
  for (const matchSnapshot of matches.docs) {
    const match = matchSnapshot.data();
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) {
      try {
        await settleTimeout(matchSnapshot.ref);
      } catch (error) {
        console.error('Chess timeout settlement failed for match ' + matchSnapshot.id + ':', error);
        failures.push(error);
      }
    }
  }
  for (const queueSnapshot of queues.docs) {
    if (isExpiredQueue(queueSnapshot.data())) {
      const uid = queueSnapshot.id;
      try {
        await db.runTransaction(async transaction => {
          const [queue, presence] = await Promise.all([
            transaction.get(queueSnapshot.ref),
            transaction.get(db.collection('chessPlayers').doc(uid))
          ]);
          if (queue.exists && queue.data().status === 'waiting' && isExpiredQueue(queue.data())) {
            transaction.delete(queueSnapshot.ref);
            if (presence.exists && presence.data().status === 'waiting') {
              transaction.delete(db.collection('chessPlayers').doc(uid));
            }
          }
        });
      } catch (error) {
        console.error('Chess queue cleanup failed for user ' + uid + ':', error);
        failures.push(error);
      }
    }
  }
  for (const matchSnapshot of whotMatches.docs) {
    const match = matchSnapshot.data();
    if (Number(match.turnDeadlineAt || 0) <= Date.now()) {
      try {
        await settleWhotTimeout(matchSnapshot.ref);
      } catch (error) {
        console.error('Whot timeout settlement failed for match ' + matchSnapshot.id + ':', error);
        failures.push(error);
      }
    }
  }
  for (const queueSnapshot of whotQueues.docs) {
    if (isExpiredQueue(queueSnapshot.data())) {
      const uid = queueSnapshot.id;
      try {
        await db.runTransaction(async transaction => {
          const [queue, presence] = await Promise.all([
            transaction.get(queueSnapshot.ref),
            transaction.get(db.collection('whotPlayers').doc(uid))
          ]);
          if (queue.exists && queue.data().status === 'waiting' && isExpiredQueue(queue.data())) {
            transaction.delete(queueSnapshot.ref);
            if (presence.exists && presence.data().status === 'waiting') {
              transaction.delete(db.collection('whotPlayers').doc(uid));
            }
          }
        });
      } catch (error) {
        console.error('Whot queue cleanup failed for user ' + uid + ':', error);
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new Error('Some chess or Whot timeout/queue cleanup jobs failed.');
});

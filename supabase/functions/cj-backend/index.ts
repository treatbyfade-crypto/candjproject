import {
  ApiError,
  commitFirestoreWrites,
  getFirestoreDocument,
  newFirestoreDocumentId,
  verifyFirebaseIdToken,
  type FirebasePrincipal,
  type FirestoreDocument,
  type FirestoreWrite
} from "../_shared/firebase-rest.ts";
import {
  encodeTransferPinSalt,
  hashTransferPin,
  verifyTransferPin
} from "../_shared/transfer-pin.ts";
import { gameHandlers } from "./games.ts";

const ADMIN_EMAIL = "admin@cj.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_EARNING_AMOUNT = 1000;
const ALLOWED_ORIGINS = new Set([
  "https://www.cjlimited.com.ng",
  "https://cjlimited.com.ng",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

type JsonRecord = Record<string, unknown>;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function jsonResponse(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
  });
}

function documentPrecondition(document: FirestoreDocument): FirestoreWrite["precondition"] {
  if (!document.exists) return { exists: false };
  if (!document.updateTime) {
    throw new ApiError(502, "unavailable", "Firebase returned a document without an update time.");
  }
  return { updateTime: document.updateTime };
}

function accountName(data: JsonRecord, uid: string): string {
  return String(data.name || data.username || uid).slice(0, 80);
}

function requireUid(principal: FirebasePrincipal): string {
  if (!principal.uid) throw new ApiError(401, "unauthenticated", "Sign in before continuing.");
  assertPathSegment(principal.uid, "account");
  return principal.uid;
}

function assertPathSegment(value: string, label: string): void {
  if (!value || value.length > 128 || value.includes("/")) {
    throw new ApiError(400, "invalid-argument", `Choose a valid ${label}.`);
  }
}

function validateRequestId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,36}$/.test(value)) {
    throw new ApiError(400, "invalid-argument", `This ${label} request is invalid. Try again.`);
  }
  return value;
}

async function setTransferPin(principal: FirebasePrincipal, data: JsonRecord): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const pin = data.pin;
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    throw new ApiError(400, "invalid-argument", "Transfer PIN must contain 4 to 6 digits.");
  }

  const [user, existingPin] = await Promise.all([
    getFirestoreDocument(`users/${uid}`),
    getFirestoreDocument(`transferPins/${uid}`)
  ]);
  if (!user.exists) throw new ApiError(404, "not-found", "Your account record could not be found.");

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = encodeTransferPinSalt(saltBytes);
  const hash = await hashTransferPin(pin, saltBytes);
  const writes: FirestoreWrite[] = [
    {
      path: `transferPins/${uid}`,
      data: { salt, hash, updatedAt: new Date() },
      precondition: documentPrecondition(existingPin)
    },
    {
      path: `users/${uid}`,
      data: { hasTransferPin: true },
      updateMask: ["hasTransferPin", "transferPinSalt", "transferPinHash", "transferPinUpdatedAt"],
      precondition: documentPrecondition(user)
    }
  ];
  await commitFirestoreWrites(writes);
  return { hasTransferPin: true };
}

async function transferWallet(principal: FirebasePrincipal, data: JsonRecord): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const recipientId = data.recipientId;
  const amount = Number(data.amount);
  const pin = data.pin;
  const requestId = validateRequestId(data.requestId, "transfer");
  if (typeof recipientId !== "string") {
    throw new ApiError(400, "invalid-argument", "Choose another valid C&J member.");
  }
  assertPathSegment(recipientId, "C&J member");
  if (recipientId === uid) throw new ApiError(400, "invalid-argument", "Choose another valid C&J member.");
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new ApiError(400, "invalid-argument", "Transfer amount must be a positive whole number.");
  }
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    throw new ApiError(400, "invalid-argument", "Enter your 4 to 6 digit Transfer PIN.");
  }

  const note = typeof data.note === "string" ? data.note.trim().slice(0, 240) : "";
  const requestPath = `walletTransfers/${uid}_${requestId}`;
  const attemptsPath = `transferPinAttempts/${uid}`;
  const [sender, pinDocument, attempts, existingRequest] = await Promise.all([
    getFirestoreDocument(`users/${uid}`),
    getFirestoreDocument(`transferPins/${uid}`),
    getFirestoreDocument(attemptsPath),
    getFirestoreDocument(requestPath)
  ]);
  if (!sender.exists) throw new ApiError(404, "not-found", "Your account record could not be found.");
  if (existingRequest.exists) {
    const saved = existingRequest.data;
    if (saved.senderId !== uid || saved.recipientId !== recipientId || saved.amount !== amount) {
      throw new ApiError(409, "already-exists", "This transfer request ID was already used.");
    }
    return {
      balance: saved.senderBalanceAfter,
      recipientName: saved.recipientName,
      amount
    };
  }

  const senderData = sender.data;
  const legacyPin = !pinDocument.exists;
  const pinData = pinDocument.exists
    ? pinDocument.data
    : { salt: senderData.transferPinSalt, hash: senderData.transferPinHash };
  const lockedUntil = Number(attempts.data.lockedUntil || 0);
  if (lockedUntil > Date.now()) {
    throw new ApiError(429, "resource-exhausted", "Too many incorrect PIN attempts. Try again later.");
  }
  if (typeof pinData.salt !== "string" || typeof pinData.hash !== "string") {
    throw new ApiError(412, "failed-precondition", "Create a Transfer PIN in Settings before requesting a transfer.");
  }

  if (!await verifyTransferPin(pin, pinData.salt, pinData.hash)) {
    const now = Date.now();
    const windowStartedAt = Number(attempts.data.windowStartedAt || 0);
    const recentFailures = attempts.exists && now - windowStartedAt < 15 * 60 * 1000
      ? Number(attempts.data.failedCount || 0)
      : 0;
    const failedCount = recentFailures + 1;
    await commitFirestoreWrites([{
      path: attemptsPath,
      data: {
        failedCount,
        windowStartedAt: recentFailures ? windowStartedAt : now,
        lockedUntil: failedCount >= 5 ? now + 15 * 60 * 1000 : 0
      },
      precondition: documentPrecondition(attempts)
    }]);
    throw new ApiError(403, "permission-denied", "Incorrect Transfer PIN.");
  }

  const [recipient, currentPin] = await Promise.all([
    getFirestoreDocument(`users/${recipientId}`),
    getFirestoreDocument(`transferPins/${uid}`)
  ]);
  if (!recipient.exists) throw new ApiError(404, "not-found", "Sender or recipient account could not be found.");
  if (pinDocument.exists &&
      (!currentPin.exists || currentPin.data.salt !== pinData.salt || currentPin.data.hash !== pinData.hash)) {
    throw new ApiError(412, "failed-precondition", "Your Transfer PIN changed. Try again.");
  }
  if (!pinDocument.exists &&
      (senderData.transferPinSalt !== pinData.salt || senderData.transferPinHash !== pinData.hash)) {
    throw new ApiError(412, "failed-precondition", "Your Transfer PIN changed. Try again.");
  }

  const senderProfile = sender.data;
  const recipientProfile = recipient.data;
  if (!(senderProfile.membership as JsonRecord | undefined)?.active) {
    throw new ApiError(412, "failed-precondition", "Activate your membership before sending transfers.");
  }
  if (["frozen", "disabled"].includes(String(senderProfile.accountStatus))) {
    throw new ApiError(403, "permission-denied", "Your account cannot send transfers while restricted.");
  }
  if (["frozen", "disabled"].includes(String(recipientProfile.accountStatus))) {
    throw new ApiError(412, "failed-precondition", "This recipient account cannot receive transfers.");
  }

  const senderBalance = Number(senderProfile.balance || 0);
  const recipientBalance = Number(recipientProfile.balance || 0);
  if (!Number.isSafeInteger(senderBalance) || senderBalance < amount ||
      !Number.isSafeInteger(recipientBalance) || recipientBalance < 0 ||
      !Number.isSafeInteger(recipientBalance + amount)) {
    throw new ApiError(412, "failed-precondition", "A wallet balance is invalid or insufficient.");
  }

  const senderName = accountName(senderProfile, uid);
  const recipientName = accountName(recipientProfile, recipientId);
  const now = new Date();
  const senderBalanceAfter = senderBalance - amount;
  const notificationSenderId = newFirestoreDocumentId();
  const notificationRecipientId = newFirestoreDocumentId();
  const senderUpdate: JsonRecord = { balance: senderBalanceAfter };
  const senderMask = ["balance"];
  const writes: FirestoreWrite[] = [
    {
      path: `users/${uid}`,
      data: senderUpdate,
      updateMask: senderMask,
      precondition: documentPrecondition(sender)
    },
    {
      path: `users/${recipientId}`,
      data: { balance: recipientBalance + amount },
      updateMask: ["balance"],
      precondition: documentPrecondition(recipient)
    },
    {
      path: `transactions/transfer_${uid}_${requestId}_sent`,
      data: {
        userId: uid,
        userName: senderName,
        personName: recipientName,
        type: "transfer_sent",
        amount: -amount,
        recipientUserId: recipientId,
        recipientName,
        note,
        date: now,
        status: "completed"
      },
      precondition: { exists: false }
    },
    {
      path: `transactions/transfer_${uid}_${requestId}_received`,
      data: {
        userId: recipientId,
        userName: recipientName,
        personName: senderName,
        type: "transfer_received",
        amount,
        senderUserId: uid,
        senderName,
        note,
        date: now,
        status: "completed"
      },
      precondition: { exists: false }
    },
    {
      path: `notifications/${notificationSenderId}`,
      data: {
        userId: uid,
        title: "Transfer sent",
        message: `N${amount.toLocaleString()} sent to ${recipientName}.`,
        read: false,
        createdAt: now
      },
      precondition: { exists: false }
    },
    {
      path: `notifications/${notificationRecipientId}`,
      data: {
        userId: recipientId,
        title: "Transfer received",
        message: `N${amount.toLocaleString()} received from ${senderName}.`,
        read: false,
        createdAt: now
      },
      precondition: { exists: false }
    },
    {
      path: requestPath,
      data: {
        senderId: uid,
        recipientId,
        amount,
        senderBalanceAfter,
        recipientName,
        createdAt: now
      },
      precondition: { exists: false }
    },
    {
      path: attemptsPath,
      data: { failedCount: 0, windowStartedAt: Date.now(), lockedUntil: 0 },
      precondition: documentPrecondition(attempts)
    }
  ];

  if (legacyPin) {
    writes.push(
      {
        path: `transferPins/${uid}`,
        data: { salt: pinData.salt, hash: pinData.hash, updatedAt: now },
        precondition: { exists: false }
      },
      {
        path: `users/${uid}`,
        data: { hasTransferPin: true },
        updateMask: ["hasTransferPin", "transferPinSalt", "transferPinHash", "transferPinUpdatedAt"],
        precondition: documentPrecondition(sender)
      }
    );
    writes[0].data = { ...senderUpdate, hasTransferPin: true };
    writes[0].updateMask = ["balance", "hasTransferPin", "transferPinSalt", "transferPinHash", "transferPinUpdatedAt"];
    writes.splice(9, 1);
  } else {
    writes.push({
      path: `transferPins/${uid}`,
      data: { salt: pinData.salt, hash: pinData.hash },
      updateMask: ["salt", "hash"],
      precondition: documentPrecondition(currentPin)
    });
  }

  await commitFirestoreWrites(writes);
  return { balance: senderBalanceAfter, recipientName, amount };
}

async function adjustWalletAsAdmin(principal: FirebasePrincipal, data: JsonRecord): Promise<JsonRecord> {
  if (principal.email !== ADMIN_EMAIL) {
    throw new ApiError(403, "permission-denied", "Administrator access is required.");
  }
  const userId = data.userId;
  if (typeof userId !== "string") throw new ApiError(400, "invalid-argument", "Choose a valid member account.");
  assertPathSegment(userId, "member account");

  const balanceType = data.balanceType === undefined ? "wallet" : data.balanceType;
  const action = data.action;
  const amount = Number(data.amount);
  const requestId = validateRequestId(data.requestId, "adjustment");
  if (!["wallet", "lagosLife"].includes(String(balanceType)) ||
      !["credit", "debit"].includes(String(action)) ||
      (balanceType === "lagosLife" && action !== "credit")) {
    throw new ApiError(400, "invalid-argument", "This wallet adjustment type is invalid.");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new ApiError(400, "invalid-argument", "Enter a positive whole-number amount.");
  }

  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 240) : "";
  const balanceField = balanceType === "lagosLife" ? "lagosLifeBalance" : "balance";
  const requestPath = `adminWalletAdjustments/${principal.uid}_${requestId}`;
  const ledgerCollection = balanceType === "lagosLife" ? "lagosLifeTransactions" : "transactions";
  const ledgerPath = `${ledgerCollection}/admin_${principal.uid}_${requestId}`;
  const notificationPath = `notifications/${newFirestoreDocumentId()}`;
  const [existingRequest, user] = await Promise.all([
    getFirestoreDocument(requestPath),
    getFirestoreDocument(`users/${userId}`)
  ]);

  if (existingRequest.exists) {
    const saved = existingRequest.data;
    if (saved.userId !== userId || saved.balanceType !== balanceType ||
        saved.action !== action || saved.amount !== amount) {
      throw new ApiError(409, "already-exists", "This adjustment request ID was already used.");
    }
    return { balance: saved.balanceAfter, memberName: saved.memberName };
  }
  if (!user.exists) throw new ApiError(404, "not-found", "Member account could not be found.");
  const currentBalance = Number(user.data[balanceField] || 0);
  const balanceAfter = action === "credit" ? currentBalance + amount : currentBalance - amount;
  if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
      !Number.isSafeInteger(balanceAfter) || balanceAfter < 0) {
    throw new ApiError(412, "failed-precondition", "The wallet balance cannot safely accept this adjustment.");
  }

  const memberName = String(user.data.name || user.data.email || userId).slice(0, 80);
  const label = action === "credit" ? "Balance credited" : "Balance debited";
  const now = new Date();
  const writes: FirestoreWrite[] = [
    {
      path: `users/${userId}`,
      data: { [balanceField]: balanceAfter },
      updateMask: [balanceField],
      precondition: documentPrecondition(user)
    },
    {
      path: ledgerPath,
      data: {
        userId,
        userName: memberName,
        userEmail: String(user.data.email || ""),
        type: balanceType === "lagosLife" ? "admin_credit" : `admin_${action}`,
        personName: memberName,
        description: `${label} by administrator: ${reason || "Administrator balance adjustment"}`,
        amount: action === "credit" ? amount : -amount,
        date: now,
        status: "completed",
        adminId: principal.uid,
        adminName: String(principal.name || "Administrator").slice(0, 80),
        reason
      },
      precondition: { exists: false }
    },
    {
      path: notificationPath,
      data: {
        userId,
        title: balanceType === "lagosLife" ? "Lagos Life funds added" : label,
        message: balanceType === "lagosLife"
          ? `An administrator added N${amount.toLocaleString()} to your Lagos Life balance. Reason: ${reason || "Administrator Lagos Life funding"}.`
          : `Your wallet balance was ${action === "credit" ? "increased" : "decreased"} by N${amount.toLocaleString()}. Reason: ${reason || "Administrator balance adjustment"}.`,
        read: false,
        createdAt: now,
        type: action === "credit" ? "deposit" : "withdrawal"
      },
      precondition: { exists: false }
    },
    {
      path: requestPath,
      data: {
        adminId: principal.uid,
        userId,
        balanceType,
        action,
        amount,
        balanceAfter,
        memberName,
        createdAt: now
      },
      precondition: { exists: false }
    }
  ];
  await commitFirestoreWrites(writes);
  return { balance: balanceAfter, memberName };
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const millis = new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function assertRewardAccount(data: JsonRecord): void {
  if (["frozen", "disabled"].includes(String(data.accountStatus))) {
    throw new ApiError(403, "permission-denied", "Your account cannot earn while restricted.");
  }
  const membership = data.membership as JsonRecord | undefined;
  if (membership?.active !== true) {
    throw new ApiError(412, "failed-precondition", "Your membership must be active first.");
  }
}

async function claimDailyEarning(principal: FirebasePrincipal): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const user = await getFirestoreDocument(`users/${uid}`);
  if (!user.exists) throw new ApiError(404, "not-found", "Your account record could not be found.");
  assertRewardAccount(user.data);
  const membership = (user.data.membership || {}) as JsonRecord;
  const now = Date.now();
  const dueAt = timestampMillis(membership.nextEarningAt) ??
    (timestampMillis(membership.startAt) !== null ? timestampMillis(membership.startAt)! + DAY_MS : null);
  const checkin = (user.data.dailyCheckin || {}) as JsonRecord;
  const lastCheckin = timestampMillis(checkin.lastCheckinAt) ?? timestampMillis(membership.startAt);
  const currentBalance = Number(user.data.balance || 0);
  const totalEarned = Number(user.data.totalEarned || 0);
  if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
      !Number.isSafeInteger(totalEarned) || totalEarned < 0) {
    throw new ApiError(412, "failed-precondition", "Your wallet or earnings balance is invalid.");
  }
  if (dueAt === null || now < dueAt || lastCheckin === null || now - lastCheckin >= DAY_MS) {
    return { credited: false, balance: currentBalance, totalEarned, nextEarningAt: dueAt };
  }

  const ledgerPath = `transactions/daily_${uid}_${dueAt}`;
  const ledger = await getFirestoreDocument(ledgerPath);
  if (ledger.exists) return { credited: false, balance: currentBalance, totalEarned, nextEarningAt: dueAt };
  const balance = currentBalance + DAILY_EARNING_AMOUNT;
  const earned = totalEarned + DAILY_EARNING_AMOUNT;
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(earned)) {
    throw new ApiError(412, "failed-precondition", "Your wallet cannot safely accept this earning.");
  }
  const nextEarningAt = dueAt + DAY_MS;
  await commitFirestoreWrites([
    {
      path: `users/${uid}`,
      data: { balance, totalEarned, membership: { nextEarningAt: new Date(nextEarningAt) } },
      updateMask: ["balance", "totalEarned", "membership.nextEarningAt"],
      precondition: documentPrecondition(user)
    },
    {
      path: ledgerPath,
      data: {
        userId: uid,
        userName: accountName(user.data, uid),
        type: "earning",
        description: "Daily C&J earning",
        amount: DAILY_EARNING_AMOUNT,
        date: new Date(),
        status: "completed"
      },
      precondition: { exists: false }
    }
  ]);
  return { credited: true, amount: DAILY_EARNING_AMOUNT, balance, totalEarned: earned, nextEarningAt };
}

async function claimDailyCheckin(principal: FirebasePrincipal): Promise<JsonRecord> {
  const uid = requireUid(principal);
  const user = await getFirestoreDocument(`users/${uid}`);
  if (!user.exists) throw new ApiError(404, "not-found", "Your account record could not be found.");
  assertRewardAccount(user.data);
  const membership = (user.data.membership || {}) as JsonRecord;
  if (membership.status && membership.status !== "active") {
    throw new ApiError(412, "failed-precondition", "Check-in is available after your membership is approved.");
  }

  const now = Date.now();
  const checkin = (user.data.dailyCheckin || {}) as JsonRecord;
  const previous = timestampMillis(checkin.lastCheckinAt);
  if (previous !== null && now - previous < DAY_MS) {
    throw new ApiError(412, "failed-precondition", `Your next check-in is available ${new Date(previous + DAY_MS).toISOString()}.`);
  }
  const dueAt = timestampMillis(membership.nextEarningAt);
  let earningLedgerPath = "";
  let earningLedger: FirestoreDocument | null = null;
  if (previous !== null && dueAt !== null && dueAt > previous && dueAt <= previous + DAY_MS && now >= dueAt) {
    earningLedgerPath = `transactions/daily_${uid}_${dueAt}`;
    earningLedger = await getFirestoreDocument(earningLedgerPath);
  }
  const earning = earningLedgerPath && !earningLedger?.exists ? DAILY_EARNING_AMOUNT : 0;
  const previousDay = Number(checkin.day || 0);
  const missedDeadline = previous === null || now - previous >= DAY_MS;
  const nextDay = missedDeadline ? 1 : previousDay >= 7 ? 1 : previousDay + 1;
  const balance = Number(user.data.balance || 0);
  const totalEarned = Number(user.data.totalEarned || 0);
  if (!Number.isSafeInteger(balance) || balance < 0 ||
      !Number.isSafeInteger(totalEarned) || totalEarned < 0) {
    throw new ApiError(412, "failed-precondition", "Your wallet or earnings balance is invalid.");
  }
  const updatedBalance = balance + earning;
  const updatedTotalEarned = totalEarned + earning;
  if (!Number.isSafeInteger(updatedBalance) || !Number.isSafeInteger(updatedTotalEarned)) {
    throw new ApiError(412, "failed-precondition", "Your wallet cannot safely accept this earning.");
  }

  const checkedInAt = new Date(now);
  const nextEarningAt = membership.active && missedDeadline ? now + DAY_MS : dueAt;
  const dailyCheckin = {
    lastCheckinAt: checkedInAt,
    day: nextDay,
    registeredAt: checkin.registeredAt || user.data.createdAt || checkedInAt
  };
  const update: JsonRecord = { dailyCheckin };
  const updateMask = ["dailyCheckin"];
  if (earning) {
    update.balance = updatedBalance;
    update.totalEarned = updatedTotalEarned;
    updateMask.push("balance", "totalEarned");
  }
  if (membership.active && missedDeadline) {
    update.membership = { nextEarningAt: new Date(nextEarningAt!) };
    updateMask.push("membership.nextEarningAt");
  }
  const writes: FirestoreWrite[] = [{
    path: `users/${uid}`,
    data: update,
    updateMask,
    precondition: documentPrecondition(user)
  }];
  if (earningLedgerPath && earning) {
    writes.push({
      path: earningLedgerPath,
      data: {
        userId: uid,
        userName: accountName(user.data, uid),
        type: "earning",
        description: "Daily C&J earning",
        amount: earning,
        date: checkedInAt,
        status: "completed"
      },
      precondition: { exists: false }
    });
  }
  await commitFirestoreWrites(writes);
  return {
    day: nextDay,
    checkedInAt: now,
    earning,
    earningLedgerId: earningLedgerPath && earning ? earningLedgerPath.split("/").pop() : "",
    balance: updatedBalance,
    totalEarned: updatedTotalEarned,
    nextEarningAt
  };
}

const handlers: Record<string, (principal: FirebasePrincipal, data: JsonRecord) => Promise<JsonRecord>> = {
  ...gameHandlers,
  walletSetTransferPin: setTransferPin,
  walletTransfer: transferWallet,
  adminAdjustWallet: adjustWalletAsAdmin,
  claimDailyEarning: principal => claimDailyEarning(principal),
  claimDailyCheckin: principal => claimDailyCheckin(principal)
};

Deno.serve(async request => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse(403, { error: { code: "permission-denied", message: "Origin is not allowed." } }, origin);
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: { code: "invalid-argument", message: "Use POST." } }, origin);
  }

  try {
    const principal = await verifyFirebaseIdToken(request);
    let body: JsonRecord;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "invalid-argument", "Request body must be valid JSON.");
    }
    const name = body.name;
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(handlers, name)) {
      throw new ApiError(404, "unimplemented", "This server function has not been migrated to Supabase yet.");
    }
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data as JsonRecord
      : {};
    const result = await handlers[name](principal, data);
    return jsonResponse(200, { result }, origin);
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse(error.status, { error: { code: error.code, message: error.message } }, origin);
    }
    console.error("Supabase callable backend failed:", error);
    return jsonResponse(500, {
      error: { code: "internal", message: "The server could not complete this request." }
    }, origin);
  }
});

import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT
} from "npm:jose@5.9.6";
import type { JWTPayload } from "npm:jose@5.9.6";
import {
  decodeFirestoreFields,
  encodeFirestoreValue,
  encodeFirestoreFields,
  encodeResourceName
} from "./firestore-values.ts";

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "candjproject-1485c";
const FIREBASE_ROOT = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

let cachedGoogleAccessToken = "";
let cachedGoogleAccessTokenExpiresAt = 0;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type FirebasePrincipal = {
  uid: string;
  email: string;
  name: string;
};

export type FirestoreDocument = {
  exists: boolean;
  data: Record<string, unknown>;
  updateTime?: string;
};

export type FirestoreWrite = {
  path: string;
  data?: Record<string, unknown>;
  updateMask?: string[];
  precondition?: { exists: boolean } | { updateTime: string };
  delete?: boolean;
};

export type FirestoreQueryFilter = {
  fieldPath: string;
  value: unknown;
};

export type FirestoreQuery = {
  collection: string;
  filters?: FirestoreQueryFilter[];
  limit?: number;
};

export type FirestoreQueryDocument = FirestoreDocument & {
  id: string;
  path: string;
};

export type FirestoreTransaction = {
  get(path: string): Promise<FirestoreDocument>;
  query(query: FirestoreQuery): Promise<FirestoreQueryDocument[]>;
  set(path: string, data: Record<string, unknown>, merge?: boolean): void;
  update(path: string, data: Record<string, unknown>): void;
  delete(path: string): void;
};

export async function verifyFirebaseIdToken(request: Request): Promise<FirebasePrincipal> {
  const authorization = request.headers.get("Authorization") || "";
  const idToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!idToken) throw new ApiError(401, "unauthenticated", "A Firebase sign-in token is required.");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID
    }));
  } catch (error) {
    if (error instanceof Error && /^(JWT|JWS|JW)/.test(error.name)) {
      throw new ApiError(401, "unauthenticated", "Your Firebase sign-in token is invalid or expired.");
    }
    throw new ApiError(503, "unavailable", "Firebase sign-in could not be verified right now.");
  }

  const uid = String(payload.sub || "");
  if (!uid) throw new ApiError(401, "unauthenticated", "Your Firebase sign-in token has no user ID.");
  return {
    uid,
    email: String(payload.email || "").trim().toLowerCase(),
    name: String(payload.name || "")
  };
}

async function getGoogleAccessToken(): Promise<string> {
  if (cachedGoogleAccessToken && Date.now() < cachedGoogleAccessTokenExpiresAt - 60_000) {
    return cachedGoogleAccessToken;
  }

  const serviceAccountText = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!serviceAccountText) {
    throw new ApiError(500, "failed-precondition", "The Firebase service-account secret is not configured in Supabase.");
  }

  let serviceAccount: { client_email?: string; private_key?: string };
  try {
    serviceAccount = JSON.parse(serviceAccountText);
  } catch {
    throw new ApiError(500, "failed-precondition", "The Firebase service-account secret is not valid JSON.");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new ApiError(500, "failed-precondition", "The Firebase service-account secret is missing required credentials.");
  }

  const signingKey = await importPKCS8(serviceAccount.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/cloud-platform" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string") {
    throw new ApiError(502, "unavailable", "Google rejected the Firebase service-account credentials.");
  }

  cachedGoogleAccessToken = result.access_token;
  cachedGoogleAccessTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return cachedGoogleAccessToken;
}

async function googleRequest(
  url: string,
  accessToken: string,
  init: RequestInit = {},
  allowNotFound = false
): Promise<Record<string, unknown> | null> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let result: Record<string, unknown> = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { message: text };
    }
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const error = result.error as { message?: string; status?: string } | undefined;
    const conflict = response.status === 409 || response.status === 412 ||
      error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
    throw new ApiError(
      conflict ? 409 : 502,
      conflict ? "aborted" : "unavailable",
      error?.message || "A Firebase data request failed."
    );
  }
  return result;
}

export async function getFirestoreDocument(path: string): Promise<FirestoreDocument> {
  const accessToken = await getGoogleAccessToken();
  const result = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(`${FIREBASE_ROOT}/${path}`)}`,
    accessToken,
    {},
    true
  );
  if (!result) return { exists: false, data: {} };
  const fields = (result.fields || {}) as Record<string, Record<string, unknown>>;
  return {
    exists: true,
    data: decodeFirestoreFields(fields),
    updateTime: String(result.updateTime || "")
  };
}

export async function commitFirestoreWrites(writes: FirestoreWrite[]): Promise<void> {
  await writeFirestoreCommit(writes);
}

async function writeFirestoreCommit(writes: FirestoreWrite[], transactionId?: string): Promise<void> {
  if (!writes.length && !transactionId) return;
  if (writes.length > 500) throw new ApiError(400, "invalid-argument", "Too many Firestore writes in one request.");
  const accessToken = await getGoogleAccessToken();
  const encodedWrites = writes.map(write => {
    const name = `${FIREBASE_ROOT}/${write.path}`;
    if (write.delete) {
      return {
        delete: name,
        ...(write.precondition ? { currentDocument: write.precondition } : {})
      };
    }
    if (!write.data) throw new TypeError("Firestore update data is required.");
    return {
      update: { name, fields: encodeFirestoreFields(write.data) },
      ...(write.updateMask?.length ? { updateMask: { fieldPaths: write.updateMask } } : {}),
      ...(write.precondition ? { currentDocument: write.precondition } : {})
    };
  });
  await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(FIREBASE_ROOT)}:commit`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        writes: encodedWrites,
        ...(transactionId ? { transaction: transactionId } : {})
      })
    }
  );
}

function decodeDocumentResponse(result: Record<string, unknown>): FirestoreDocument {
  const fields = (result.fields || {}) as Record<string, Record<string, unknown>>;
  return {
    exists: true,
    data: decodeFirestoreFields(fields),
    updateTime: String(result.updateTime || "")
  };
}

function documentPathFromName(name: unknown): string {
  const prefix = `${FIREBASE_ROOT}/`;
  if (typeof name !== "string" || !name.startsWith(prefix)) {
    throw new ApiError(502, "unavailable", "Firebase returned a document outside the configured project.");
  }
  return name.slice(prefix.length);
}

async function readTransactionDocument(
  path: string,
  transactionId: string,
  accessToken: string
): Promise<FirestoreDocument> {
  const response = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(FIREBASE_ROOT)}:batchGet`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        documents: [`${FIREBASE_ROOT}/${path}`],
        transaction: transactionId
      })
    }
  );
  const entries = response as unknown as Array<Record<string, unknown>>;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new ApiError(502, "unavailable", "Firebase returned an invalid transaction read.");
  }
  const entry = entries[0];
  if (entry.missing) return { exists: false, data: {} };
  if (!entry.found || typeof entry.found !== "object") {
    throw new ApiError(502, "unavailable", "Firebase returned an invalid transaction document.");
  }
  return decodeDocumentResponse(entry.found as Record<string, unknown>);
}

async function queryTransactionDocuments(
  query: FirestoreQuery,
  transactionId: string,
  accessToken: string
): Promise<FirestoreQueryDocument[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(query.collection)) {
    throw new ApiError(400, "invalid-argument", "Invalid Firestore collection.");
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new ApiError(400, "invalid-argument", "Invalid Firestore query limit.");
  }
  const filters = query.filters || [];
  if (filters.length > 10 || filters.some(filter =>
    typeof filter.fieldPath !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(filter.fieldPath)
  )) {
    throw new ApiError(400, "invalid-argument", "Invalid Firestore query filters.");
  }
  const fieldFilters = filters.map(filter => ({
    fieldFilter: {
      field: { fieldPath: filter.fieldPath },
      op: "EQUAL",
      value: encodeFirestoreValue(filter.value)
    }
  }));
  const where = fieldFilters.length === 0
    ? {}
    : fieldFilters.length === 1
      ? fieldFilters[0]
      : { compositeFilter: { op: "AND", filters: fieldFilters } };
  const structuredQuery = {
    from: [{ collectionId: query.collection }],
    ...where,
    ...(query.limit ? { limit: query.limit } : {})
  };
  const result = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(FIREBASE_ROOT)}:runQuery`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({ structuredQuery, transaction: transactionId })
    }
  );
  const rows = result as unknown as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) {
    throw new ApiError(502, "unavailable", "Firebase returned an invalid transaction query.");
  }
  return rows.flatMap(row => {
    if (!row.document || typeof row.document !== "object") return [];
    const document = row.document as Record<string, unknown>;
    const path = documentPathFromName(document.name);
    return [{
      ...decodeDocumentResponse(document),
      id: path.slice(path.lastIndexOf("/") + 1),
      path
    }];
  });
}

async function runFirestoreTransactionOnce<T>(
  callback: (transaction: FirestoreTransaction) => Promise<T>
): Promise<T> {
  const accessToken = await getGoogleAccessToken();
  const begin = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(FIREBASE_ROOT)}:beginTransaction`,
    accessToken,
    { method: "POST", body: JSON.stringify({ options: { readWrite: {} } }) }
  );
  const transactionId = typeof begin?.transaction === "string" ? begin.transaction : "";
  if (!transactionId) {
    throw new ApiError(502, "unavailable", "Firebase did not start a transaction.");
  }

  const writes: FirestoreWrite[] = [];
  const readCache = new Map<string, FirestoreDocument>();
  const transaction: FirestoreTransaction = {
    async get(path) {
      const cached = readCache.get(path);
      if (cached) return cached;
      const document = await readTransactionDocument(path, transactionId, accessToken);
      readCache.set(path, document);
      return document;
    },
    query: query => queryTransactionDocuments(query, transactionId, accessToken),
    set(path, data, merge = false) {
      writes.push({
        path,
        data,
        ...(merge ? { updateMask: Object.keys(data) } : {})
      });
    },
    update(path, data) {
      writes.push({ path, data, updateMask: Object.keys(data) });
    },
    delete(path) {
      writes.push({ path, delete: true });
    }
  };

  try {
    const result = await callback(transaction);
    await writeFirestoreCommit(writes, transactionId);
    return result;
  } catch (error) {
    try {
      await googleRequest(
        `https://firestore.googleapis.com/v1/${encodeResourceName(FIREBASE_ROOT)}:rollback`,
        accessToken,
        { method: "POST", body: JSON.stringify({ transaction: transactionId }) }
      );
    } catch (rollbackError) {
      console.error("Could not roll back Firebase transaction:", rollbackError);
    }
    throw error;
  }
}

export async function runFirestoreTransaction<T>(
  callback: (transaction: FirestoreTransaction) => Promise<T>
): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runFirestoreTransactionOnce(callback);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "aborted" || attempt === maxAttempts - 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
  throw new ApiError(409, "aborted", "Firebase could not complete the transaction after several retries.");
}

export function newFirestoreDocumentId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function firebaseProjectId(): string {
  return FIREBASE_PROJECT_ID;
}

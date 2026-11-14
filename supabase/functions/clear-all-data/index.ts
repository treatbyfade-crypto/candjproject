import { createClient } from "npm:@supabase/supabase-js@2.49.0";
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT
} from "npm:jose@5.9.6";
import {
  STALE_NEVER_ACTIVATED_ACCOUNT_RETENTION_MS,
  isStaleNeverActivatedAccount,
  membershipHasStarted,
  timestampMillis
} from "./cleanup-eligibility.ts";

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "candjproject-1485c";
const SUPABASE_BUCKET = "cj-uploads";
const ADMIN_EMAIL = "admin@cj.com";
const FIREBASE_ROOT = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);
const ALLOWED_ORIGINS = new Set([
  "https://www.cjlimited.com.ng",
  "https://cjlimited.com.ng",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

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

function encodeResourceName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

async function getGoogleAccessToken(): Promise<string> {
  const serviceAccountText = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!serviceAccountText) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is not configured.");

  const serviceAccount = JSON.parse(serviceAccountText);
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain client_email and private_key.");
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
  if (!response.ok || !result.access_token) {
    throw new Error(`Google service-account authentication failed: ${result.error_description || result.error || response.status}`);
  }
  return result.access_token;
}

async function googleRequest(
  url: string,
  accessToken: string,
  init: RequestInit = {},
  allowNotFound = false
): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let result: any = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { message: text };
    }
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Google API ${response.status}: ${result.error?.message || result.message || response.statusText}`);
  }
  return result;
}

async function listStorageFiles(storage: any, folder = ""): Promise<string[]> {
  const paths: string[] = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await storage.from(SUPABASE_BUCKET).list(folder, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" }
    });
    if (error) throw error;
    if (!data.length) break;

    for (const entry of data) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.id === null) paths.push(...await listStorageFiles(storage, path));
      else paths.push(path);
    }

    offset += data.length;
    if (data.length < pageSize) break;
  }
  return paths;
}

type FirebaseAccount = {
  localId: string;
  email?: string;
  displayName?: string;
  createdAt?: string;
};

async function listFirebaseUserAccounts(accessToken: string): Promise<FirebaseAccount[]> {
  const accounts: FirebaseAccount[] = [];
  let nextPageToken = "";

  do {
    const url = new URL(`https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts:batchGet`);
    url.searchParams.set("maxResults", "1000");
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const result = await googleRequest(url.toString(), accessToken);
    accounts.push(...(result.users || []).map((user: FirebaseAccount) => ({
      localId: user.localId,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt
    })));
    nextPageToken = result.nextPageToken || "";
  } while (nextPageToken);

  return accounts;
}

async function listFirebaseUsers(accessToken: string): Promise<string[]> {
  return (await listFirebaseUserAccounts(accessToken)).map((user) => user.localId);
}

type FirebaseUserProfile = {
  uid: string;
  name: string;
  email: string;
  activeMembership: boolean;
  membershipEverActivated: boolean;
  createdAtMillis: number | null;
  isAdmin: boolean;
};

async function listFirebaseUserProfiles(accessToken: string): Promise<FirebaseUserProfile[]> {
  const profiles: FirebaseUserProfile[] = [];
  let pageToken = "";

  do {
    const url = new URL(`https://firestore.googleapis.com/v1/${encodeResourceName(`${FIREBASE_ROOT}/users`)}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await googleRequest(url.toString(), accessToken);
    for (const document of result.documents || []) {
      const fields = document.fields || {};
      const membership = fields.membership?.mapValue?.fields || {};
      const role = String(fields.role?.stringValue || "").toLowerCase();
      profiles.push({
        uid: String(document.name || "").split("/").pop() || "",
        name: String(fields.name?.stringValue || ""),
        email: String(fields.email?.stringValue || fields.emailLower?.stringValue || ""),
        activeMembership: membership.active?.booleanValue === true ||
          String(membership.status?.stringValue || "").toLowerCase() === "active",
        membershipEverActivated: membershipHasStarted(membership),
        createdAtMillis: timestampMillis(
          fields.createdAt?.timestampValue ||
          fields.createdAt?.stringValue ||
          fields.createdAt?.integerValue
        ),
        isAdmin: role === "admin"
      });
    }
    pageToken = result.nextPageToken || "";
  } while (pageToken);

  return profiles;
}

async function findStaleNeverActivatedAccounts(accessToken: string, cutoffMillis: number) {
  const [accounts, profiles] = await Promise.all([
    listFirebaseUserAccounts(accessToken),
    listFirebaseUserProfiles(accessToken)
  ]);
  const profilesByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
  return accounts
    .filter((account) => {
      const profile = profilesByUid.get(account.localId);
      return isStaleNeverActivatedAccount(account, profile, cutoffMillis, ADMIN_EMAIL);
    })
    .map((account) => ({
      uid: account.localId,
      email: profilesByUid.get(account.localId)?.email || account.email || ""
    }));
}

async function findInactiveFirebaseAccounts(accessToken: string, adminUid: string) {
  const [accounts, profiles] = await Promise.all([
    listFirebaseUserAccounts(accessToken),
    listFirebaseUserProfiles(accessToken)
  ]);
  const profilesByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
  return accounts
    .filter((account) => {
      const profile = profilesByUid.get(account.localId);
      return account.localId !== adminUid &&
        String(account.email || "").trim().toLowerCase() !== ADMIN_EMAIL &&
        !profile?.isAdmin &&
        !profile?.activeMembership;
    })
    .map((account) => {
      const profile = profilesByUid.get(account.localId);
      return {
        uid: account.localId,
        email: profile?.email || account.email || "",
        name: profile?.name || account.displayName || "",
        hasProfile: Boolean(profile)
      };
    });
}

async function deleteFirebaseUsers(accessToken: string, localIds: string[]): Promise<void> {
  for (let offset = 0; offset < localIds.length; offset += 1000) {
    const result = await googleRequest(
      `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts:batchDelete`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ localIds: localIds.slice(offset, offset + 1000), force: true })
      }
    );
    if (result.errors?.length) {
      throw new Error(`Firebase reported ${result.errors.length} account deletion failure(s).`);
    }
  }
}

async function listCollectionIds(parent: string, accessToken: string): Promise<string[]> {
  const collectionIds: string[] = [];
  let pageToken = "";
  do {
    const body: Record<string, unknown> = { pageSize: 1000 };
    if (pageToken) body.pageToken = pageToken;
    const result = await googleRequest(
      `https://firestore.googleapis.com/v1/${encodeResourceName(parent)}:listCollectionIds`,
      accessToken,
      { method: "POST", body: JSON.stringify(body) }
    );
    collectionIds.push(...(result.collectionIds || []));
    pageToken = result.nextPageToken || "";
  } while (pageToken);
  return collectionIds;
}

async function listDocuments(parent: string, collectionId: string, accessToken: string): Promise<string[]> {
  const documentNames: string[] = [];
  let pageToken = "";
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/${encodeResourceName(`${parent}/${collectionId}`)}`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("showMissing", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await googleRequest(url.toString(), accessToken);
    documentNames.push(...(result.documents || []).map((document: { name: string }) => document.name));
    pageToken = result.nextPageToken || "";
  } while (pageToken);
  return documentNames;
}

async function deleteDocumentTree(documentName: string, accessToken: string): Promise<number> {
  let deleted = 0;
  for (const collectionId of await listCollectionIds(documentName, accessToken)) {
    for (const childDocument of await listDocuments(documentName, collectionId, accessToken)) {
      deleted += await deleteDocumentTree(childDocument, accessToken);
    }
  }
  const result = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(documentName)}`,
    accessToken,
    { method: "DELETE" },
    true
  );
  return deleted + (result === null ? 0 : 1);
}

function stringFieldValue(fields: Record<string, any>, key: string): string {
  const field = fields[key];
  return String(field?.stringValue || "");
}

async function deleteUserRelatedDocument(
  documentName: string,
  collectionId: string,
  accessToken: string,
  userIds: Set<string>
): Promise<number> {
  const documentId = documentName.split("/").pop() || "";
  if ((collectionId === "users" || collectionId === "verifications") && userIds.has(documentId)) {
    return await deleteDocumentTree(documentName, accessToken);
  }

  const document = await googleRequest(
    `https://firestore.googleapis.com/v1/${encodeResourceName(documentName)}`,
    accessToken,
    {},
    true
  );
  const fields = document?.fields || {};
  const ownerFields = [
    "userId",
    "uid",
    "ownerId",
    "userUid",
    "memberId",
    "sellerId",
    "senderId",
    "recipientId",
    "participantId",
    "followerId",
    "followingId"
  ];
  if (ownerFields.some((field) => userIds.has(stringFieldValue(fields, field)))) {
    return await deleteDocumentTree(documentName, accessToken);
  }

  let deleted = 0;
  for (const childCollection of await listCollectionIds(documentName, accessToken)) {
    for (const childDocument of await listDocuments(documentName, childCollection, accessToken)) {
      deleted += await deleteUserRelatedDocument(childDocument, childCollection, accessToken, userIds);
    }
  }
  return deleted;
}

async function deleteUserRelatedFirestoreData(accessToken: string, userIds: string[]): Promise<number> {
  if (!userIds.length) return 0;
  const userIdSet = new Set(userIds);
  let deleted = 0;
  for (const collectionId of await listCollectionIds(FIREBASE_ROOT, accessToken)) {
    for (const documentName of await listDocuments(FIREBASE_ROOT, collectionId, accessToken)) {
      deleted += await deleteUserRelatedDocument(documentName, collectionId, accessToken, userIdSet);
    }
  }
  return deleted;
}

async function deleteUserStorageFiles(storage: any, userIds: string[]): Promise<number> {
  if (!userIds.length) return 0;
  const userIdSet = new Set(userIds);
  const files = (await listStorageFiles(storage)).filter((path) =>
    path.split("/").some((segment) => userIdSet.has(segment))
  );
  for (let offset = 0; offset < files.length; offset += 100) {
    const { error } = await storage.from(SUPABASE_BUCKET).remove(files.slice(offset, offset + 100));
    if (error) throw new Error(`Could not delete user-uploaded files: ${error.message}`);
  }
  return files.length;
}

async function deleteFirestoreData(accessToken: string, adminUid: string): Promise<number> {
  let deleted = 0;
  for (const collectionId of await listCollectionIds(FIREBASE_ROOT, accessToken)) {
    const documents = await listDocuments(FIREBASE_ROOT, collectionId, accessToken);
    for (const documentName of documents) {
      if (collectionId === "users" && documentName === `${FIREBASE_ROOT}/users/${adminUid}`) continue;
      deleted += await deleteDocumentTree(documentName, accessToken);
    }
  }
  return deleted;
}

Deno.serve(async request => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse(403, { error: "Origin is not allowed." }, origin);
  }
  if (request.method !== "POST") return jsonResponse(405, { error: "Use POST." }, origin);

  try {
    const body = await request.json();
    const action = String(body.action || "clearAllData");

    if (action === "deleteStaleNeverActivatedAccounts") {
      const expectedSecret = Deno.env.get("INACTIVE_ACCOUNT_CLEANUP_CRON_SECRET");
      const providedSecret = request.headers.get("x-cron-secret");
      if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
        return jsonResponse(401, { error: "The scheduled cleanup request is not authorized." }, origin);
      }

      const accessToken = await getGoogleAccessToken();
      const cutoffMillis = Date.now() - STALE_NEVER_ACTIVATED_ACCOUNT_RETENTION_MS;
      const accounts = await findStaleNeverActivatedAccounts(accessToken, cutoffMillis);
      const userIds = accounts.map((account) => account.uid);
      if (!userIds.length) {
        return jsonResponse(200, {
          authAccountsDeleted: 0,
          firestoreDocumentsDeleted: 0,
          storageFilesDeleted: 0
        }, origin);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        throw new Error("Supabase server credentials are not configured.");
      }
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
      const firestoreDocumentsDeleted = await deleteUserRelatedFirestoreData(accessToken, userIds);
      const storageFilesDeleted = await deleteUserStorageFiles(supabase.storage, userIds);
      await deleteFirebaseUsers(accessToken, userIds);

      return jsonResponse(200, {
        authAccountsDeleted: userIds.length,
        firestoreDocumentsDeleted,
        storageFilesDeleted
      }, origin);
    }

    const authorization = request.headers.get("Authorization") || "";
    const idToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!idToken) return jsonResponse(401, { error: "A Firebase sign-in token is required." }, origin);

    const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID
    });
    const adminUid = String(payload.sub || "");
    const callerEmail = String(payload.email || "").trim().toLowerCase();
    if (!adminUid || callerEmail !== ADMIN_EMAIL) {
      return jsonResponse(403, { error: "Only the signed-in administrator can manage application accounts." }, origin);
    }

    if (!["clearAllData", "previewInactiveAccounts", "deleteInactiveAccounts", "deleteUserAccount"].includes(action)) {
      return jsonResponse(400, { error: "The requested account-management action is not supported." }, origin);
    }

    if (action === "deleteUserAccount") {
      const targetUid = String(body.targetUid || "").trim();
      if (!targetUid || targetUid.length > 128) {
        return jsonResponse(400, { error: "A valid user account ID is required." }, origin);
      }
      if (targetUid === adminUid) {
        return jsonResponse(403, { error: "You cannot delete the administrator account you are signed in with." }, origin);
      }

      const accessToken = await getGoogleAccessToken();
      const [accounts, profile] = await Promise.all([
        listFirebaseUserAccounts(accessToken),
        googleRequest(
          `https://firestore.googleapis.com/v1/${encodeResourceName(`${FIREBASE_ROOT}/users/${targetUid}`)}`,
          accessToken,
          {},
          true
        )
      ]);
      const account = accounts.find((candidate) => candidate.localId === targetUid);
      if (!account && !profile) {
        return jsonResponse(404, { error: "The selected account no longer exists." }, origin);
      }
      const profileFields = profile?.fields || {};
      const profileRole = String(profileFields.role?.stringValue || "").trim().toLowerCase();
      const profileEmail = String(profileFields.email?.stringValue || profileFields.emailLower?.stringValue || "").trim().toLowerCase();
      const accountEmail = String(account?.email || "").trim().toLowerCase();
      if (profileRole === "admin" || profileEmail === ADMIN_EMAIL || accountEmail === ADMIN_EMAIL) {
        return jsonResponse(403, { error: "Administrator accounts are protected from deletion." }, origin);
      }

      const confirmationEmails = [...new Set([profileEmail, accountEmail].filter(Boolean))];
      const confirmationMatches = confirmationEmails.some(email => body.confirmation === `DELETE USER ${email}`);
      const confirmationMatchesUid = !confirmationEmails.length && body.confirmation === `DELETE USER ${targetUid}`;
      if (!confirmationMatches && !confirmationMatchesUid) {
        return jsonResponse(400, { error: "The selected user's exact confirmation phrase is required." }, origin);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !supabaseServiceRoleKey) throw new Error("Supabase server credentials are not configured.");
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
      const firestoreDocumentsDeleted = await deleteUserRelatedFirestoreData(accessToken, [targetUid]);
      const storageFilesDeleted = await deleteUserStorageFiles(supabase.storage, [targetUid]);
      if (account) await deleteFirebaseUsers(accessToken, [targetUid]);

      return jsonResponse(200, {
        authAccountsDeleted: account ? 1 : 0,
        firestoreDocumentsDeleted,
        storageFilesDeleted,
        email: account?.email || profileEmail
      }, origin);
    }

    if (action === "previewInactiveAccounts" || action === "deleteInactiveAccounts") {
      if (action === "deleteInactiveAccounts" && body.confirmation !== "DELETE INACTIVE ACCOUNTS") {
        return jsonResponse(400, { error: "The required inactive-account confirmation phrase is missing." }, origin);
      }

      const accessToken = await getGoogleAccessToken();
      const inactiveAccounts = await findInactiveFirebaseAccounts(accessToken, adminUid);
      if (action === "previewInactiveAccounts") {
        const accountsWithoutProfile = inactiveAccounts.filter((account) => !account.hasProfile).length;
        const requestedOffset = Number(body.offset);
        const requestedLimit = Number(body.limit);
        const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, 200)
          : 100;
        return jsonResponse(200, {
          inactiveAccountCount: inactiveAccounts.length,
          accountsWithoutProfile,
          inactiveMembershipAccounts: inactiveAccounts.length - accountsWithoutProfile,
          offset,
          limit,
          accounts: inactiveAccounts.slice(offset, offset + limit).map(({ uid, email, name, hasProfile }) => ({
            uid,
            email,
            name,
            hasProfile
          }))
        }, origin);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !supabaseServiceRoleKey) throw new Error("Supabase server credentials are not configured.");
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
      const userIds = inactiveAccounts.map((account) => account.uid);
      const firestoreDocumentsDeleted = await deleteUserRelatedFirestoreData(accessToken, userIds);
      const storageFilesDeleted = await deleteUserStorageFiles(supabase.storage, userIds);
      await deleteFirebaseUsers(accessToken, userIds);

      return jsonResponse(200, {
        authAccountsDeleted: userIds.length,
        firestoreDocumentsDeleted,
        storageFilesDeleted
      }, origin);
    }

    if (body.confirmation !== "CLEAR ALL DATA") {
      return jsonResponse(400, { error: "The required confirmation phrase is missing." }, origin);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceRoleKey) throw new Error("Supabase server credentials are not configured.");

    const accessToken = await getGoogleAccessToken();
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const storageFiles = await listStorageFiles(supabase.storage);
    for (let offset = 0; offset < storageFiles.length; offset += 100) {
      const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(storageFiles.slice(offset, offset + 100));
      if (error) throw new Error(`Could not delete uploaded files: ${error.message}`);
    }

    const userIds = (await listFirebaseUsers(accessToken)).filter(uid => uid !== adminUid);
    await deleteFirebaseUsers(accessToken, userIds);
    const firestoreDocumentsDeleted = await deleteFirestoreData(accessToken, adminUid);

    return jsonResponse(200, {
      authAccountsDeleted: userIds.length,
      firestoreDocumentsDeleted,
      storageFilesDeleted: storageFiles.length
    }, origin);
  } catch (error) {
    console.error("Secure cleanup failed:", error);
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Secure cleanup failed." }, origin);
  }
});

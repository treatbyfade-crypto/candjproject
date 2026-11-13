type FirebaseAccount = {
  localId: string;
  email?: string;
  createdAt?: string;
};

type FirebaseUserProfile = {
  activeMembership: boolean;
  membershipEverActivated: boolean;
  createdAtMillis: number | null;
  isAdmin: boolean;
};

type FirestoreMembershipFields = Record<string, {
  stringValue?: string;
  timestampValue?: string;
  integerValue?: string | number;
} | undefined>;

export function timestampMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const numericValue = Number(value);
  const parsed = Number.isFinite(numericValue) ? numericValue : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function membershipHasStarted(membership: FirestoreMembershipFields): boolean {
  const startAt = membership.startAt || {};
  return Boolean(
    startAt.stringValue?.trim() ||
    startAt.timestampValue ||
    Number(startAt.integerValue || 0) > 0
  );
}

export function isStaleNeverActivatedAccount(
  account: FirebaseAccount,
  profile: FirebaseUserProfile | undefined,
  cutoffMillis: number,
  adminEmail: string
): boolean {
  if (String(account.email || "").trim().toLowerCase() === adminEmail) return false;
  if (profile?.isAdmin || profile?.activeMembership || profile?.membershipEverActivated) return false;
  const createdAtMillis = profile?.createdAtMillis ?? timestampMillis(account.createdAt);
  return createdAtMillis !== null && createdAtMillis <= cutoffMillis;
}

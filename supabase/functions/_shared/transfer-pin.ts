function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  } catch {
    throw new Error("The saved Transfer PIN is invalid.");
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function derivePinHash(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = new Uint8Array(salt.byteLength);
  saltBytes.set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 180000, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashTransferPin(pin: string, salt: Uint8Array): Promise<string> {
  return encodeBase64(await derivePinHash(pin, salt));
}

export async function verifyTransferPin(pin: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await derivePinHash(pin, decodeBase64(salt));
  const expected = decodeBase64(expectedHash);
  let difference = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    difference |= (actual[index] || 0) ^ (expected[index] || 0);
  }
  return difference === 0;
}

export function encodeTransferPinSalt(value: Uint8Array): string {
  return encodeBase64(value);
}

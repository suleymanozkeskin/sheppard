/**
 * Capability tokens. A token is the only proof of identity; a handle is display
 * text and proves nothing. The database stores only the hash, so reading the
 * database never yields a usable credential.
 */

const TOKEN_BYTES = 32;

/** Mints a 256-bit token. Returned to the caller exactly once, never stored. */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * A plain SHA-256 is sufficient here: the input is 256 bits of uniform
 * randomness, so there is no guessable-password space to slow an attacker down.
 */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token, "utf8").digest("hex");
}

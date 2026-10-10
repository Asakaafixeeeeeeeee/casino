// src/crypto.ts
//
// Password hashing. Kept in its own module so the algorithm can be swapped
// (argon2id / bcrypt) without touching registration logic.
//
// Uses Node's built-in crypto.pbkdf2Sync as the zero-dependency default. In
// production you almost certainly want argon2id; the only contract here is:
//   hashPassword(plain) -> Promise<string>  (verifier-independent encoding)
//   verifyPassword(plain, hash) -> Promise<boolean>
// A production hash encodes its own algorithm + params, so a migration path
// exists without a password reset.

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const ITERATIONS = 240_000;
const KEY_LEN = 32;
const DIGEST = "sha256";

/** Format: pbkdf2$<iterations>$<salt_b64>$<hash_b64> */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const salt = randomBytes(16);
      const derived = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
      const encoded = `pbkdf2$${ITERATIONS}$${salt.toString("base64")}$${derived.toString("base64")}`;
      resolve(encoded);
    } catch (e) {
      reject(e);
    }
  });
}

/** Constant-time comparison; parses the legacy format above. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const [algo, iters, saltB64, hashB64] = hash.split("$");
      if (algo !== "pbkdf2" || !saltB64 || !hashB64 || !iters) return resolve(false);
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(hashB64, "base64");
      const candidate = pbkdf2Sync(password, salt, Number(iters), expected.length, DIGEST);
      resolve(
        candidate.length === expected.length && timingSafeEqual(candidate, expected)
      );
    } catch {
      resolve(false);
    }
  });
}

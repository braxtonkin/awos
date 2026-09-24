import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const algorithm = 'aes-256-gcm';
const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;

const keyProblem = `must be base64 of exactly ${String(keyBytes)} bytes`;

const environment = z
  .object({
    CREDENTIAL_KEY: z
      .string({ error: keyProblem })
      .trim()
      .pipe(z.base64({ error: keyProblem }))
      .transform(text => Buffer.from(text, 'base64'))
      .refine(key => key.length === keyBytes, { error: keyProblem }),
    CREDENTIAL_KEY_VERSION: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/, { error: 'must be a whole number from 1 to 999999999' })
      .transform(Number),
  })
  .transform(({ CREDENTIAL_KEY, CREDENTIAL_KEY_VERSION }): { readonly version: number; readonly key: KeyObject } => ({
    version: CREDENTIAL_KEY_VERSION,
    key: createSecretKey(CREDENTIAL_KEY),
  }))
  .brand<'SealingKey'>();

const thrown = z.object({ message: z.string() });

export type SealingKey = z.infer<typeof environment>;

export type Sealed = { readonly ciphertext: Buffer; readonly keyVersion: number };

export type Unsealed =
  | { readonly secret: string }
  | { readonly unreadable: 'key-version' | 'unauthenticated'; readonly reason: string };

export function sealingKey(env: NodeJS.ProcessEnv): SealingKey {
  const parsed = environment.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `CREDENTIAL_KEY ${keyProblem}, such as the output of openssl rand -base64 32, and CREDENTIAL_KEY_VERSION must be a whole number from 1 to 999999999. ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function seal(key: SealingKey, secret: string, context: string): Sealed {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv(algorithm, key.key, nonce, { authTagLength: tagBytes });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]), keyVersion: key.version };
}

export function unseal(key: SealingKey, sealed: Sealed, context: string): Unsealed {
  if (sealed.keyVersion !== key.version) {
    const stored = String(sealed.keyVersion);
    const held = String(key.version);
    return {
      unreadable: 'key-version',
      reason: `This credential was sealed with key version ${stored}, and this service holds key version ${held}. Replace the credential so it is sealed with version ${held}. If version ${held} is the wrong key, start the service with the key it should hold.`,
    };
  }
  const tagAt = sealed.ciphertext.length - tagBytes;
  try {
    const decipher = createDecipheriv(algorithm, key.key, sealed.ciphertext.subarray(0, nonceBytes), { authTagLength: tagBytes });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(sealed.ciphertext.subarray(tagAt));
    return { secret: Buffer.concat([decipher.update(sealed.ciphertext.subarray(nonceBytes, tagAt)), decipher.final()]).toString('utf8') };
  } catch (error) {
    return {
      unreadable: 'unauthenticated',
      reason: `This credential failed its AES-256-GCM authentication check (${thrown.safeParse(error).data?.message ?? 'no message'}), so it changed after it was sealed, was moved from another credential's row, or was sealed with another key of the same version. Replace the credential to seal it again.`,
    };
  }
}

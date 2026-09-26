import { sealingKey, type SealingKey } from '../../features/credentials/seal.ts';

export type Keyed = { readonly key: SealingKey } | { readonly off: string };

const off = "Replacing logins is off, because the dashboard has no valid CREDENTIAL_KEY and CREDENTIAL_KEY_VERSION. Start it with the engine's key to turn replacing on.";

export function credentialKey(): Keyed {
  try {
    return { key: sealingKey(process.env) };
  } catch {
    return { off };
  }
}

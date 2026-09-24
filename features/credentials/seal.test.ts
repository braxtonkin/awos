import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { seal, sealingKey, unseal, type Sealed, type SealingKey, type Unsealed } from './seal.ts';

type Random = () => number;

type Property = 'boundToContext' | 'flipFails' | 'freshNonce' | 'keyBound' | 'roundTrip' | 'versionNamed';

type Sealer = {
  readonly seal: (key: SealingKey, secret: string, context: string) => Sealed;
  readonly unseal: (key: SealingKey, sealed: Sealed, context: string) => Unsealed;
};

type Sample = { readonly secret: string; readonly context: string; readonly otherContext: string; readonly flipAt: number; readonly flipWith: number };

const samples = 10_000;
const longestSecret = 2048;
const nonceBytes = 12;
const tagBytes = 16;

const utf8Widths: readonly (readonly [number, number])[] = [
  [0x00, 0x7f],
  [0x80, 0x7ff],
  [0x800, 0xd7ff],
  [0xe000, 0xffff],
  [0x10000, 0x10ffff],
];

const contexts: readonly string[] = ['codex 1', 'codex 2', 'github 1', 'github 2', 'github team'];

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick needs at least one item');
  return item;
}

const between = (random: Random, [low, high]: readonly [number, number]): number => low + Math.floor(random() * (high - low + 1));

const secretFrom = (random: Random): string =>
  String.fromCodePoint(...Array.from({ length: between(random, [1, longestSecret]) }, () => between(random, pick(random, utf8Widths))));

function sampleFrom(random: Random): Sample {
  const secret = secretFrom(random);
  const context = pick(random, contexts);
  return { secret, context, otherContext: pick(random, contexts.filter(other => other !== context)), flipAt: random(), flipWith: between(random, [1, 255]) };
}

const random = mulberry32(20_260_923);

const keyMaterial = (): string => Buffer.from(Array.from({ length: 32 }, () => between(random, [0, 255]))).toString('base64');

const keyOf = (material: string, version: number): SealingKey => sealingKey({ CREDENTIAL_KEY: material, CREDENTIAL_KEY_VERSION: String(version) });

const versionSeven = keyOf(keyMaterial(), 7);

const anotherVersionSeven = keyOf(keyMaterial(), 7);

const versionEleven = keyOf(keyMaterial(), 11);

const fixedMaterial = keyMaterial();

const seeded: readonly Sample[] = Array.from({ length: samples }, () => sampleFrom(random));

function flipped(sealed: Sealed, sample: Sample): Sealed {
  const ciphertext = Buffer.from(sealed.ciphertext);
  const position = Math.floor(sample.flipAt * ciphertext.length);
  const byte = ciphertext[position];
  if (byte === undefined) throw new Error(`no byte at ${String(position)}`);
  ciphertext[position] = byte ^ sample.flipWith;
  return { ciphertext, keyVersion: sealed.keyVersion };
}

const nonceOf = (sealed: Sealed): string => sealed.ciphertext.subarray(0, nonceBytes).toString('hex');

const opensTo = (unsealed: Unsealed, secret: string): boolean => 'secret' in unsealed && unsealed.secret === secret;

const unauthenticated = (unsealed: Unsealed): boolean => 'unreadable' in unsealed && unsealed.unreadable === 'unauthenticated';

const namesBothVersions = (unsealed: Unsealed): boolean =>
  'unreadable' in unsealed && unsealed.unreadable === 'key-version' && /\b7\b/.test(unsealed.reason) && /\b11\b/.test(unsealed.reason);

function broken(make: () => Sealer): readonly Property[] {
  const sealer = make();
  const twin = make();
  const found = new Set<Property>();
  const nonces = new Set<string>();
  for (const sample of seeded) {
    const sealed = sealer.seal(versionSeven, sample.secret, sample.context);
    nonces.add(nonceOf(sealed)).add(nonceOf(twin.seal(versionSeven, sample.secret, sample.context)));
    if (!opensTo(sealer.unseal(versionSeven, sealed, sample.context), sample.secret)) found.add('roundTrip');
    if (!unauthenticated(sealer.unseal(versionSeven, flipped(sealed, sample), sample.context))) found.add('flipFails');
    if (!unauthenticated(sealer.unseal(versionSeven, sealed, sample.otherContext))) found.add('boundToContext');
    if (!unauthenticated(sealer.unseal(anotherVersionSeven, sealed, sample.context))) found.add('keyBound');
    if (!namesBothVersions(sealer.unseal(versionEleven, sealed, sample.context))) found.add('versionNamed');
  }
  if (nonces.size !== 2 * seeded.length) found.add('freshNonce');
  return [...found].sort();
}

const one =
  (sealer: Sealer): (() => Sealer) =>
  () =>
    sealer;

function sealWithNonce(key: SealingKey, secret: string, context: string, nonce: Buffer): Sealed {
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: tagBytes });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]), keyVersion: key.version };
}

function counterNonce(): Sealer {
  let count = 0;
  return {
    seal: (key, secret, context) => {
      const nonce = Buffer.alloc(nonceBytes);
      nonce.writeUInt32BE(count, nonceBytes - 4);
      count += 1;
      return sealWithNonce(key, secret, context, nonce);
    },
    unseal,
  };
}

const ctrWithoutTag: Sealer = {
  seal: (key, secret) => {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-ctr', key.key, Buffer.concat([nonce, Buffer.alloc(4)]));
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, body, Buffer.alloc(tagBytes)]), keyVersion: key.version };
  },
  unseal: (key, sealed) => {
    if (sealed.keyVersion !== key.version) {
      return { unreadable: 'key-version', reason: `sealed under version ${String(sealed.keyVersion)}, opened with version ${String(key.version)}` };
    }
    const decipher = createDecipheriv('aes-256-ctr', key.key, Buffer.concat([sealed.ciphertext.subarray(0, nonceBytes), Buffer.alloc(4)]));
    return { secret: Buffer.concat([decipher.update(sealed.ciphertext.subarray(nonceBytes, -tagBytes)), decipher.final()]).toString('utf8') };
  },
};

const sealers: readonly { readonly name: string; readonly make: () => Sealer; readonly breaks: readonly Property[] }[] = [
  { name: 'seal.ts', make: one({ seal, unseal }), breaks: [] },
  { name: 'fixedNonce', make: one({ seal: (key, secret, context) => sealWithNonce(key, secret, context, Buffer.alloc(nonceBytes)), unseal }), breaks: ['freshNonce'] },
  { name: 'counterNonce', make: counterNonce, breaks: ['freshNonce'] },
  { name: 'latin1Text', make: one({ seal: (key, secret, context) => seal(key, Buffer.from(secret, 'latin1').toString('latin1'), context), unseal }), breaks: ['roundTrip'] },
  { name: 'noContext', make: one({ seal: (key, secret) => seal(key, secret, ''), unseal: (key, sealed) => unseal(key, sealed, '') }), breaks: ['boundToContext'] },
  { name: 'noVersionCheck', make: one({ seal, unseal: (key, sealed, context) => unseal(key, { ...sealed, keyVersion: key.version }, context) }), breaks: ['versionNamed'] },
  {
    name: 'ignoresKey',
    make: one({
      seal: (key, secret, context) => seal(keyOf(fixedMaterial, key.version), secret, context),
      unseal: (key, sealed, context) => unseal(keyOf(fixedMaterial, key.version), sealed, context),
    }),
    breaks: ['keyBound'],
  },
  { name: 'ctrWithoutTag', make: one(ctrWithoutTag), breaks: ['boundToContext', 'flipFails', 'keyBound'] },
];

for (const { name, make, breaks } of sealers) {
  test(`${name} breaks ${breaks.length === 0 ? 'no property' : breaks.join(' and ')} over ${String(samples)} seeded secrets`, { timeout: 120_000 }, () => {
    expect(broken(make)).toEqual(breaks);
  });
}

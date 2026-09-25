import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { sql } from 'kysely';
import { getContainerRuntimeClient } from 'testcontainers';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { provePlants } from './invariants.ts';
import type { Secret } from './kinds.ts';
import { checksModel } from './checks-model.ts';
import { codexHomePrefix } from './codex-check.ts';
import { laneChecks } from './lanes.ts';
import { liveScenarios } from './live.ts';
import { mutantName, mutants, noMutantYet, simulate, type MutantName, type Plan, type Run } from './simulate.ts';
import { mutantEntries, mutantOption } from './mutants.ts';
import { seal, sealingKey, unseal } from './seal.ts';
import { expiring, open, replace, writeBack, type Opened, type Replaced, type Replacement, type Slot } from './store.ts';
import {
  accessProblems,
  codex,
  day,
  fakeGithubToken,
  fakeLogin,
  fakeRefreshToken,
  github,
  inScratch,
  messageOf,
  newKey,
  offline,
  probe,
  replacementOf,
  storeAll,
  storeToken,
  tokenReads,
  tokenWrites,
  type Entry,
  type Outcome,
  type World,
} from './world.ts';

type Refused = Extract<Replaced, { readonly refused: string }>['refused'];

type Needle = { readonly name: string; readonly text: string };

const gcmFailure = 'Unsupported state or unable to authenticate data';
const benchmark = { runs: 3, seals: 10_000, limitMicroseconds: 1000 };

const listedContainers = z.array(z.object({ Id: z.string(), NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }) }));
const execution = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() });

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const outcomeOf = (replaced: Replaced): string => ('credential' in replaced ? `credential ${replaced.credential}` : replaced.refused);

async function ciphertextOf(world: World, slot: Slot): Promise<Buffer> {
  const { ciphertext } = await world.engine
    .selectFrom('credential')
    .select('ciphertext')
    .where('connector', '=', slot.connector)
    .where('person_id', 'is not distinct from', slot.owner)
    .executeTakeFirstOrThrow();
  return ciphertext;
}

async function rowsWritten(world: World): Promise<number> {
  const credentials = await world.engine.selectFrom('credential').select('id').execute();
  const actions = await world.engine.selectFrom('human_action').select('id').execute();
  return credentials.length + actions.length;
}

async function recordProblems(world: World, replacement: Replacement): Promise<readonly string[]> {
  const action = await world.engine
    .selectFrom('human_action')
    .select(['person_id', 'at', 'kind', 'connector', 'detail'])
    .where('id', '=', replacement.action)
    .executeTakeFirst();
  if (action === undefined) return [`action ${replacement.action} was not recorded`];
  const credential = await world.engine
    .selectFrom('credential')
    .select('action_id')
    .where('connector', '=', replacement.secret.connector)
    .where('person_id', 'is not distinct from', replacement.owner)
    .executeTakeFirst();
  const recorded = { person_id: action.person_id, at: action.at.toISOString(), kind: action.kind, connector: action.connector, detail: action.detail };
  const expected = {
    person_id: replacement.by,
    at: replacement.at.toISOString(),
    kind: 'replace_credential',
    connector: replacement.secret.connector,
    detail: { owner: replacement.owner, madeForAutoWorker: true },
  };
  return [
    ...(isDeepStrictEqual(recorded, expected) ? [] : [`action ${replacement.action} recorded ${JSON.stringify(recorded)}, not ${JSON.stringify(expected)}`]),
    ...(credential?.action_id === replacement.action ? [] : [`the credential cites action ${credential?.action_id ?? 'none'}, not ${replacement.action}`]),
  ];
}

async function opensByteForByte(world: World): Promise<Outcome> {
  const login = fakeLogin(day(3), fakeRefreshToken());
  const token = fakeGithubToken();
  const stored = [
    { owner: world.ada, openAs: `0${world.ada}`, secret: codex(login, true), text: login.text },
    { owner: `00${world.team}`, openAs: world.team, secret: github(token), text: token },
  ];
  const problems: string[] = [];
  for (const { owner, openAs, secret, text } of stored) {
    const replaced = await replace(world.dashboard, world.key, replacementOf(world, owner, secret));
    const opened = await open(world.engine, world.key, { connector: secret.connector, owner: openAs });
    if ('refused' in replaced) problems.push(`the dashboard's ${secret.connector} replacement was refused: ${replaced.reason}`);
    else if (!('secret' in opened)) problems.push(`the engine could not open the ${secret.connector} credential as owner ${openAs}: ${opened.reason}`);
    else if (!Buffer.from(opened.secret, 'utf8').equals(Buffer.from(text, 'utf8'))) problems.push(`the ${secret.connector} credential opened to other bytes`);
  }
  return {
    problems,
    detail: `a ${String(Buffer.byteLength(login.text))}-byte Codex login for Ada, and a GitHub token for the release team's shared account, which is a personal credential of a shared person, each opened unchanged, with zero-padded owner ids naming the same rows`,
  };
}

async function dashboardCannotRead(world: World): Promise<Outcome> {
  const readings = await probe(world, await storeToken(world, world.ada), tokenReads);
  return {
    problems: readings.filter(reading => reading.outcome !== 'refused').map(reading => `as the dashboard, ${reading.name} was not refused`),
    detail: `${String(readings.length)} reads refused with 42501: ${readings.map(reading => reading.name).join(', ')}`,
  };
}

async function writesOnlyThroughFunction(world: World): Promise<Outcome> {
  const readings = await probe(world, await storeToken(world, world.ada), tokenWrites);
  return {
    problems: readings.filter(reading => reading.outcome !== 'refused').map(reading => `as the dashboard, ${reading.name} was not refused`),
    detail: `replace_credential stored a token as the dashboard, and ${String(readings.length)} direct writes were refused with 42501: ${readings.map(reading => reading.name).join(', ')}`,
  };
}

async function noOtherAccess(world: World): Promise<Outcome> {
  return {
    problems: await accessProblems(world),
    detail: 'the dashboard can select no view that reads credential.ciphertext, and replace_credential is the only function it can execute whose body names credential',
  };
}

async function recordsWhoAndWhen(world: World): Promise<Outcome> {
  const slot: Slot = { connector: 'codex', owner: world.ada };
  const first: Replacement = { action: randomUUID(), by: world.ada, at: day(1), owner: world.ada, secret: codex(fakeLogin(day(3), fakeRefreshToken()), true) };
  const replay: Replacement = { ...first, secret: codex(fakeLogin(day(5), fakeRefreshToken()), true) };
  const newer = fakeLogin(day(4), fakeRefreshToken());
  const second: Replacement = { action: randomUUID(), by: world.bo, at: day(2), owner: world.ada, secret: codex(newer, true) };
  const replaced = await replace(world.dashboard, world.key, first);
  if (!('credential' in replaced)) return { problems: [`the replacement was refused: ${replaced.reason}`], detail: '' };
  const problems: string[] = [...(await recordProblems(world, first))];
  const sealed = await ciphertextOf(world, slot);
  const early = await replace(world.dashboard, world.key, replay);
  if (!('credential' in early) || early.credential !== replaced.credential) problems.push(`a replay before the second replacement gave ${outcomeOf(early)}, not credential ${replaced.credential}`);
  if (!(await ciphertextOf(world, slot)).equals(sealed)) problems.push('a replay changed the stored ciphertext');
  const again = await replace(world.dashboard, world.key, second);
  if ('refused' in again) problems.push(`the second replacement was refused: ${again.reason}`);
  problems.push(...(await recordProblems(world, second)));
  const late = await replace(world.dashboard, world.key, replay);
  if (!('refused' in late) || late.refused !== 'already-recorded') problems.push(`a replay after the second replacement gave ${outcomeOf(late)}, not already-recorded`);
  const opened = await open(world.engine, world.key, slot);
  if (!('secret' in opened) || opened.secret !== newer.text || opened.replacement !== second.action) {
    problems.push('after the second replacement, the credential does not open to the newer login under the newer action');
  }
  return {
    problems,
    detail:
      "Ada replaced her Codex login and Bo replaced it again, both as the dashboard; each action holds its person, time, kind, connector, and owner, a replay of Ada's action returned her credential and wrote nothing, and after Bo's replacement the same replay was already recorded",
  };
}

async function refusesMalformed(world: World): Promise<Outcome> {
  const spaced = `ghp_${randomBytes(9).toString('hex')} ${randomBytes(9).toString('hex')}`;
  const notJson = `rt_${randomBytes(24).toString('base64url')}`;
  const notJwt = `not-a-jwt-${randomBytes(9).toString('hex')}`;
  const withNotJwt = fakeLogin(day(3), '', { access_token: notJwt });
  const nullRefresh = fakeLogin(day(3), '', { refresh_token: null });
  const farFuture = fakeLogin(new Date(Date.UTC(10_000, 0, 2)), '');
  const token = fakeGithubToken();
  const cases: readonly { readonly what: string; readonly owner: string | null; readonly secret: Secret; readonly refused: Refused; readonly secrets: readonly string[] }[] = [
    { what: 'a GitHub token with a space', owner: world.ada, secret: github(spaced), refused: 'malformed', secrets: [spaced] },
    { what: 'a login that is not JSON', owner: world.ada, secret: { connector: 'codex', login: notJson, madeForAutoWorker: true }, refused: 'malformed', secrets: [notJson] },
    { what: 'an access token that is not a JWT', owner: world.ada, secret: codex(withNotJwt, true), refused: 'malformed', secrets: [notJwt, ...withNotJwt.tokens] },
    { what: 'a null refresh_token', owner: world.ada, secret: codex(nullRefresh, true), refused: 'malformed', secrets: nullRefresh.tokens },
    { what: 'an exp after the year 10000', owner: world.ada, secret: codex(farFuture, true), refused: 'malformed', secrets: farFuture.tokens },
    { what: 'a GitHub credential with no owner', owner: null, secret: github(token), refused: 'person-does-not-fit-connector', secrets: [token] },
  ];
  const problems: string[] = [];
  for (const { what, owner, secret, refused, secrets } of cases) {
    const replaced = await replace(world.dashboard, world.key, replacementOf(world, owner, secret));
    if (!('refused' in replaced)) problems.push(`${what} was stored`);
    else if (replaced.refused !== refused) problems.push(`${what} was refused as ${replaced.refused}, not ${refused}`);
    else if (replaced.reason.trim() === '') problems.push(`${what} was refused with no instruction`);
    else if (secrets.some(text => replaced.reason.includes(text))) problems.push(`the refusal of ${what} repeats the secret`);
  }
  const written = await rowsWritten(world);
  if (written > 0) problems.push(`the refusals wrote ${String(written)} rows`);
  return { problems, detail: `${String(cases.length)} secrets refused, each with an instruction that does not repeat the secret, and no credential or action was written` };
}

async function flippedByteFails(world: World): Promise<Outcome> {
  const stored = await storeToken(world, world.ada);
  const last = stored.ciphertext.length - 1;
  const regions: readonly (readonly [string, number])[] = [
    ['nonce', 0],
    ['body', Math.floor(last / 2)],
    ['tag', last],
  ];
  const problems: string[] = [];
  for (const [region, position] of regions) {
    const flipped = Buffer.from(stored.ciphertext);
    const byte = flipped[position];
    if (byte === undefined) throw new Error(`the ciphertext has no byte ${String(position)}`);
    flipped[position] = byte ^ 0x01;
    await world.engine.updateTable('credential').set({ ciphertext: flipped }).where('id', '=', stored.id).execute();
    const opened = await open(world.engine, world.key, stored.slot);
    if ('secret' in opened) problems.push(`a flipped byte in the ${region} still opened`);
    else if (opened.unreadable !== 'unauthenticated' || !opened.reason.includes(gcmFailure)) problems.push(`a flipped byte in the ${region} gave ${opened.unreadable}: ${opened.reason}`);
  }
  return { problems, detail: `one flipped byte in the nonce, the body, and the tag each failed with "${gcmFailure}"` };
}

async function otherVersionFails(world: World): Promise<Outcome> {
  const stored = await storeToken(world, world.ada);
  const opened = await open(world.engine, newKey(2), stored.slot);
  const control = await open(world.engine, world.key, stored.slot);
  if ('secret' in opened) return { problems: ['the token opened under key version 2'], detail: '' };
  const named = opened.unreadable === 'key-version' && /\b1\b/.test(opened.reason) && /\b2\b/.test(opened.reason);
  return {
    problems: [
      ...(named ? [] : [`opening under key version 2 gave ${opened.unreadable}: ${opened.reason}`]),
      ...('secret' in control && control.secret === stored.text ? [] : ['the token no longer opens under key version 1']),
    ],
    detail: opened.reason,
  };
}

async function movedTokenFails(world: World): Promise<Outcome> {
  const adas = await storeToken(world, world.ada);
  const bos = await storeToken(world, world.bo);
  await world.engine.updateTable('credential').set({ ciphertext: adas.ciphertext }).where('id', '=', bos.id).execute();
  const moved = await open(world.engine, world.key, bos.slot);
  const control = await open(world.engine, world.key, adas.slot);
  return {
    problems: [
      ...('unreadable' in moved && moved.unreadable === 'unauthenticated' ? [] : [`Ada's token in Bo's row gave ${'secret' in moved ? 'a token' : moved.unreadable}`]),
      ...('secret' in control && control.secret === adas.text ? [] : ["Ada's own row no longer opens"]),
    ],
    detail: "Ada's sealed GitHub token copied into Bo's row failed its GCM check, and Ada's row still opens",
  };
}

async function pgDump(url: string): Promise<string> {
  const { hostname, username, pathname } = new URL(url);
  const client = await getContainerRuntimeClient();
  const found = listedContainers
    .parse(await client.container.list())
    .find(container => Object.values(container.NetworkSettings.Networks).some(network => network.IPAddress === hostname));
  if (found === undefined) throw new Error(`no running container has the Postgres address ${hostname}`);
  const dump = execution.parse(
    await client.container.exec(client.container.getById(found.Id), ['pg_dump', '--username', decodeURIComponent(username), '--dbname', decodeURIComponent(pathname.slice(1))]),
  );
  if (dump.exitCode !== 0) throw new Error(`pg_dump exited with ${String(dump.exitCode)}: ${dump.stderr.trim()}`);
  return dump.stdout;
}

const needlesOf = (name: string, value: Buffer, form: 'utf8' | 'base64'): readonly Needle[] => [
  { name: `${name} as ${form === 'utf8' ? 'text' : 'base64'}`, text: value.toString(form) },
  { name: `${name} as hex`, text: value.toString('hex') },
];

async function dumpHoldsNoSecret(world: World): Promise<Outcome> {
  const login = fakeLogin(day(3), fakeRefreshToken());
  const token = fakeGithubToken();
  await storeAll(world, [replacementOf(world, world.ada, codex(login, true)), replacementOf(world, world.bo, github(token))]);
  const key = world.key.key.export();
  const needles = [
    ...needlesOf('the key', key, 'base64'),
    ...[login.text, ...login.tokens, token].flatMap((plaintext, index) => needlesOf(`plaintext ${String(index + 1)}`, Buffer.from(plaintext, 'utf8'), 'utf8')),
  ];
  const clean = await pgDump(world.url);
  await world.engine.schema.createTable('planted').addColumn('words', 'text').addColumn('bytes', 'bytea').execute();
  await world.engine
    .$extendTables<{ planted: { words: string; bytes: Buffer } }>()
    .insertInto('planted')
    .values([
      { words: key.toString('base64'), bytes: key },
      { words: token, bytes: Buffer.from(token, 'utf8') },
    ])
    .execute();
  const planted = await pgDump(world.url);
  const plantedNeedles = [...needlesOf('the planted key', key, 'base64'), ...needlesOf('the planted GitHub token', Buffer.from(token, 'utf8'), 'utf8')];
  return {
    problems: [
      ...needles.filter(needle => clean.includes(needle.text)).map(needle => `the dump holds ${needle.name}`),
      ...plantedNeedles.filter(needle => !planted.includes(needle.text)).map(needle => `the search missed ${needle.name}, so it cannot fail`),
    ],
    detail: `a ${String(clean.length)}-character dump holds none of ${String(needles.length)} needles, and a second dump found all ${String(plantedNeedles.length)} planted ones`,
  };
}

function keyLengths(): Outcome {
  const cases = [
    { bytes: 31, ending: '', accepted: false },
    { bytes: 32, ending: '', accepted: true },
    { bytes: 32, ending: '\n', accepted: true },
    { bytes: 33, ending: '', accepted: false },
  ];
  const problems = cases.flatMap(({ bytes, ending, accepted }) => {
    const text = randomBytes(bytes).toString('base64');
    const label = `${String(bytes)} bytes${ending === '' ? '' : ' with a trailing newline'}`;
    try {
      sealingKey({ CREDENTIAL_KEY: `${text}${ending}`, CREDENTIAL_KEY_VERSION: '1' });
      return accepted ? [] : [`${label} were accepted`];
    } catch (error) {
      const message = messageOf(error);
      if (accepted) return [`${label} were refused: ${message}`];
      return [
        ...(message.includes('CREDENTIAL_KEY') ? [] : [`the refusal of ${label} does not name CREDENTIAL_KEY`]),
        ...(message.includes(text) ? [`the refusal of ${label} shows the key`] : []),
      ];
    }
  });
  return {
    problems,
    detail: '31 and 33 bytes were refused with a message that names CREDENTIAL_KEY and never shows the key, and 32 bytes were accepted with or without a trailing newline',
  };
}

async function expiryFromExp(world: World): Promise<Outcome> {
  const expiresAt = day(3);
  const returned = [
    await replace(world.dashboard, world.key, replacementOf(world, world.ada, codex(fakeLogin(expiresAt, fakeRefreshToken()), true))),
    await replace(world.dashboard, world.key, replacementOf(world, world.ada, github(fakeGithubToken()))),
  ].map(replaced => ('refused' in replaced ? replaced.refused : (replaced.expiresAt?.toISOString() ?? null)));
  const rows = await world.engine.selectFrom('credential').select(['connector', 'expires_at']).orderBy('connector').execute();
  const stored = rows.map(row => ({ connector: row.connector, expiresAt: row.expires_at?.toISOString() ?? null }));
  return {
    problems: [
      ...(isDeepStrictEqual(returned, [expiresAt.toISOString(), null]) ? [] : [`replace returned ${JSON.stringify(returned)}`]),
      ...(isDeepStrictEqual(stored, [
        { connector: 'codex', expiresAt: expiresAt.toISOString() },
        { connector: 'github', expiresAt: null },
      ])
        ? []
        : [`stored ${JSON.stringify(stored)}`]),
    ],
    detail: `the Codex login expires at ${expiresAt.toISOString()}, its access token's exp, and the GitHub token has no expiry`,
  };
}

async function expiringWithinAWeek(world: World): Promise<Outcome> {
  await storeAll(world, [
    replacementOf(world, world.ada, codex(fakeLogin(day(3), fakeRefreshToken()), true)),
    replacementOf(world, world.bo, codex(fakeLogin(day(30), fakeRefreshToken()), true)),
    replacementOf(world, world.ada, github(fakeGithubToken())),
  ]);
  const listed = (await expiring(world.dashboard, day(7))).map(entry => ({ connector: entry.connector, owner: entry.owner, expiresAt: entry.expiresAt.toISOString() }));
  return {
    problems: isDeepStrictEqual(listed, [{ connector: 'codex', owner: world.ada, expiresAt: day(3).toISOString() }]) ? [] : [`listed ${JSON.stringify(listed)}`],
    detail: `as the dashboard role, 1 of 3 credentials expires by ${day(7).toISOString()}: Ada's Codex login, 3 days out`,
  };
}

async function refreshNeedsMark(world: World): Promise<Outcome> {
  const refreshable = fakeLogin(day(3), fakeRefreshToken());
  const unmarked = await replace(world.dashboard, world.key, replacementOf(world, world.ada, codex(refreshable, false)));
  const written = await rowsWritten(world);
  const marked = await replace(world.dashboard, world.key, replacementOf(world, world.ada, codex(refreshable, true)));
  const accessOnly = [
    await replace(world.dashboard, world.key, replacementOf(world, world.bo, codex(fakeLogin(day(3), ''), false))),
    await replace(world.dashboard, world.key, replacementOf(world, world.bo, codex(fakeLogin(day(3), ' \t '), false))),
  ];
  return {
    problems: [
      ...('refused' in unmarked && unmarked.refused === 'refresh-token-not-made-for-autoworker' ? [] : ['an unmarked login that holds a refresh token was not refused']),
      ...(written === 0 ? [] : [`the refusal wrote ${String(written)} rows`]),
      ...('credential' in marked ? [] : [`the marked login was refused: ${marked.reason}`]),
      ...accessOnly.flatMap(stored => ('credential' in stored ? [] : [`an unmarked access-only copy was refused: ${stored.reason}`])),
    ],
    detail: `unmarked, it was refused and nothing was written; marked, it was stored, and so were two unmarked copies whose refresh_token is blank or whitespace. The refusal says: ${'refused' in unmarked ? unmarked.reason : 'nothing'}`,
  };
}

async function everyKindHasARow(world: World): Promise<Outcome> {
  const kinds = (await sql<{ kind: string }>`select unnest(enum_range(null::connector_kind))::text as kind`.execute(world.engine)).rows.map(row => row.kind);
  const unmatched = async (): Promise<readonly string[]> =>
    (await sql<{ kind: string }>`select unnest(enum_range(null::connector_kind))::text as kind except select kind::text from connector order by kind`.execute(world.engine)).rows.map(
      row => row.kind,
    );
  const before = await unmatched();
  await world.engine.deleteFrom('connector').where('kind', '=', 'github').execute();
  const after = await unmatched();
  const stored = await replace(world.dashboard, world.key, replacementOf(world, world.ada, github(fakeGithubToken()))).then(
    replaced => `it returned ${outcomeOf(replaced)}`,
    (error: unknown) => messageOf(error),
  );
  const written = await rowsWritten(world);
  return {
    problems: [
      ...before.map(kind => `connector_kind ${kind} has no connector row`),
      ...(isDeepStrictEqual(after, ['github']) ? [] : [`with github's row deleted, the query reported ${JSON.stringify(after)}`]),
      ...(stored.includes('has no row in the connector table') ? [] : [`with github's row deleted, storing a GitHub token gave: ${stored}`]),
      ...(written === 0 ? [] : [`with github's row deleted, storing a GitHub token wrote ${String(written)} rows`]),
    ],
    detail: `${kinds.join(' and ')} each have a row; with github's row deleted, the same query reports github, and storing a GitHub token fails with "${stored}" and writes nothing`,
  };
}

function sealAndOpenSpeed(): Outcome {
  const key = newKey(1);
  const login = fakeLogin(day(3), fakeRefreshToken()).text;
  const context = 'autoworker credential v1 codex 1';
  const runs = Array.from({ length: benchmark.runs }, () => {
    let wrong = 0;
    const started = performance.now();
    for (let index = 0; index < benchmark.seals; index += 1) {
      const opened = unseal(key, seal(key, login, context), context);
      if (!('secret' in opened) || opened.secret !== login) wrong += 1;
    }
    return { microseconds: ((performance.now() - started) * 1000) / benchmark.seals, wrong };
  });
  const middle = median(runs.map(run => run.microseconds));
  const wrong = runs.reduce((sum, run) => sum + run.wrong, 0);
  return {
    problems: [
      ...(wrong === 0 ? [] : [`${String(wrong)} seals did not open to the login`]),
      ...(middle <= benchmark.limitMicroseconds ? [] : [`the median is ${middle.toFixed(1)} microseconds, over ${String(benchmark.limitMicroseconds)}`]),
    ],
    detail: `median ${middle.toFixed(1)} microseconds per seal and open of a ${String(Buffer.byteLength(login))}-byte Codex login; runs of ${String(benchmark.seals)}: ${runs.map(run => run.microseconds.toFixed(1)).join(', ')}`,
  };
}

const storeChecks: readonly Entry[] = [
  { name: 'the engine opens a token the dashboard sealed, byte for byte', run: inScratch(opensByteForByte) },
  { name: 'the dashboard role cannot read a sealed token', run: inScratch(dashboardCannotRead) },
  { name: 'the dashboard role writes credentials only through replace_credential', run: inScratch(writesOnlyThroughFunction) },
  {
    name: 'no view the dashboard role can select reads credential.ciphertext, and replace_credential is the only function it can execute that touches credential',
    run: inScratch(noOtherAccess),
  },
  { name: 'a replacement as the dashboard role records who made it and when', run: inScratch(recordsWhoAndWhen) },
  { name: 'a malformed secret, or an owner that does not fit the connector, is refused with an instruction and writes nothing', run: inScratch(refusesMalformed) },
  { name: 'one flipped stored byte fails opening with the GCM authentication error', run: inScratch(flippedByteFails) },
  { name: 'a token sealed under key version 1 fails to open under version 2, naming both versions', run: inScratch(otherVersionFails) },
  { name: "a sealed token moved into another person's row fails to open", run: inScratch(movedTokenFails) },
  { name: 'pg_dump holds neither the key nor any plaintext', run: inScratch(dumpHoldsNoSecret) },
  { name: 'the key must be base64 of exactly 32 bytes: 31 and 33 are refused at startup, 32 is accepted', run: offline(keyLengths) },
  { name: "expires_at is the Codex access token's exp, and a GitHub token has none", run: inScratch(expiryFromExp) },
  { name: 'credentials expiring within 7 days lists only the near-expiry row', run: inScratch(expiringWithinAWeek) },
  { name: 'a Codex login with a refresh token is stored only when marked made for AutoWorker', run: inScratch(refreshNeedsMark) },
  { name: 'every connector kind has its connector row', run: inScratch(everyKindHasARow) },
  { name: 'sealing and opening one token takes at most 1 ms at the median of 3 runs of 10,000', run: offline(sealAndOpenSpeed) },
];

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const setupCommand = join(repositoryRoot, 'services', 'engine', 'setup.ts');

const setupBudget = { runs: 5, freshMs: 5000, repeatMs: 2000 };

const setupTables = ['person', 'credential', 'human_action', 'repository', 'routine', 'routine_version', 'routine_step'] as const;

const childFailure = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });

type SetupRun = { readonly code: number; readonly stdout: string; readonly stderr: string; readonly ms: number };

type SetupWorld = {
  readonly url: string;
  readonly engine: Database;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly apply: (file: object, env?: Readonly<Record<string, string>>, flags?: readonly string[]) => Promise<SetupRun>;
  readonly rows: () => Promise<Readonly<Record<string, number>>>;
};

const sandboxRepository = { github: 'example/sandbox', branch: 'main' };

const adaLogins = { github: { env: 'ADA_GITHUB_TOKEN' }, codex: { file: 'ada-codex.json', madeForAutoWorker: true }, jira: { env: 'ADA_JIRA_LOGIN' } };

const ada = { name: 'Ada', email: 'Ada@Example.com', jiraAccountId: 'jira-ada', logins: adaLogins };

const sandboxRoutine = {
  name: 'Sandbox tickets',
  goal: 'Take each sandbox ticket to a merged pull request.',
  workflow: 'code-change',
  source: { kind: 'jira-search', jql: 'project = SANDBOX AND status = "To Do"', pageSize: 25 },
  jiraStartStatus: 'In Progress',
  jiraEndStatus: 'Done',
  ignoreLaterReviews: true,
  everyMinutes: 10,
  repository: sandboxRepository,
  creator: 'ada@example.com',
  gates: ['specify'],
  steps: { implement: { instructions: 'Keep the change small.', skills: ['typescript'] } },
};

const sandboxImage = `registry.example.com/sandbox-job@sha256:${'a'.repeat(64)}`;

const sandboxSettings = { ...sandboxRepository, image: sandboxImage, fastTestCommand: 'npm test', verifyProvider: 'tests-only', ignorableChecks: ['lint-docs'], draftLeaves: 'at-once', ignoredReviewers: ['bot-reviewer'] };

const setupFile = { admin: 'ada@example.com', people: [ada], repositories: [sandboxSettings], routines: [sandboxRoutine] };

const firstRun = ['people 1 added, 0 changed', 'team accounts 0 added, 0 changed', 'logins 3 sealed', 'repositories 1 added, 0 changed', 'routines 1 added, 0 changed', ''].join('\n');

const repeatRun = ['people 0 added, 0 changed', 'team accounts 0 added, 0 changed', 'logins 0 sealed', 'repositories 0 added, 0 changed', 'routines 0 added, 0 changed', ''].join('\n');

const describeRun = (run: SetupRun): string => `exit ${String(run.code)}, stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)}`;

const leaks = (secrets: readonly string[], runs: readonly SetupRun[]): readonly string[] =>
  runs.flatMap((run, index) => (secrets.some(secret => run.stdout.includes(secret) || run.stderr.includes(secret)) ? [`run ${String(index + 1)} printed a secret`] : []));

const nothingWritten = (rows: Readonly<Record<string, number>>): readonly string[] =>
  Object.entries(rows).flatMap(([table, count]) => (count === 0 ? [] : [`${table} holds ${String(count)} rows`]));

const lineWith = (text: string, needle: string): string => text.split('\n').find(line => line.includes(needle))?.trim() ?? '';

async function runSetup(folder: string, file: object, env: Readonly<Record<string, string>>, flags: readonly string[]): Promise<SetupRun> {
  const path = join(folder, `setup-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(file, null, 2));
  const started = performance.now();
  const finished = await promisify(execFile)(process.execPath, [setupCommand, ...flags, path], { env, cwd: repositoryRoot, timeout: 60_000 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => childFailure.parse(error),
  );
  return { ...finished, ms: performance.now() - started };
}

async function inSetupWorld<T>(postgres: TestPostgres, work: (world: SetupWorld) => Promise<T>): Promise<T> {
  const scratch = await postgres.scratch();
  const engine = connect(scratch.url, 1);
  const folder = await mkdtemp(join(tmpdir(), 'setup-'));
  const login = fakeLogin(day(30), fakeRefreshToken());
  const token = fakeGithubToken();
  const jiraToken = `ATATT3x${randomBytes(24).toString('hex')}`;
  const jira = `ada@example.com:${jiraToken}`;
  const key = randomBytes(32).toString('base64');
  await writeFile(join(folder, 'ada-codex.json'), login.text);
  const env = { DATABASE_URL: scratch.url, CREDENTIAL_KEY: key, CREDENTIAL_KEY_VERSION: '1', ADA_GITHUB_TOKEN: token, ADA_JIRA_LOGIN: jira };
  const rows = async (): Promise<Readonly<Record<string, number>>> => {
    const counted: Record<string, number> = {};
    for (const table of setupTables) counted[table] = Number((await sql<{ rows: string }>`select count(*) as rows from ${sql.table(table)}`.execute(engine)).rows[0]?.rows ?? -1);
    return counted;
  };
  try {
    return await work({ url: scratch.url, engine, env, secrets: [login.text, ...login.tokens, token, jira, jiraToken, key], apply: (file, changed = env, flags = []) => runSetup(folder, file, changed, flags), rows });
  } finally {
    await rm(folder, { recursive: true, force: true });
    await engine.destroy();
    await scratch.drop();
  }
}

const inSetup =
  (check: (world: SetupWorld) => Promise<Outcome>) =>
  (postgres: TestPostgres): Promise<Outcome> =>
    inSetupWorld(postgres, check);

async function appliesOnce(world: SetupWorld): Promise<Outcome> {
  const first = await world.apply(setupFile);
  const afterFirst = await world.rows();
  const second = await world.apply(setupFile);
  const afterSecond = await world.rows();
  const unsaved = await world.engine
    .selectFrom('repository')
    .leftJoin('human_action', on => on.onRef('human_action.id', '=', 'repository.saved_by').on('human_action.kind', '=', 'add_repository').onRef('human_action.repository_id', '=', 'repository.id'))
    .select('repository.github')
    .where('human_action.id', 'is', null)
    .execute();
  const version = await world.engine
    .selectFrom('routine_version')
    .select([
      'workflow',
      'source',
      'jira_start_status',
      'jira_end_status',
      'ignore_later_reviews',
      sql<number>`(extract(epoch from every) / 60)::float8`.as('every_minutes'),
      'needs_repository',
      sql<string[]>`gates::text[]`.as('gates'),
      'last_step',
      'version',
    ])
    .executeTakeFirst();
  const repository = await world.engine.selectFrom('repository').select(['github', 'branch', 'job_image', 'fast_test_command', 'verify_provider', 'ignorable_checks', 'draft_leaves', 'ignored_reviewers']).execute();
  const expectedRepository = [
    { github: 'example/sandbox', branch: 'main', job_image: sandboxImage, fast_test_command: 'npm test', verify_provider: 'tests-only', ignorable_checks: ['lint-docs'], draft_leaves: 'at-once', ignored_reviewers: ['bot-reviewer'] },
  ];
  const steps = await world.engine.selectFrom('routine_step').select(['step', 'instructions', sql<string[]>`skills::text[]`.as('skills')]).execute();
  const person = await world.engine.selectFrom('person').select(['id', 'email', 'jira_account_id', 'kind']).executeTakeFirst();
  const key = sealingKey(world.env);
  const owner = person?.id ?? '0';
  const opened = [await open(world.engine, key, { connector: 'github', owner }), await open(world.engine, key, { connector: 'codex', owner }), await open(world.engine, key, { connector: 'jira', owner })];
  const openedTexts = opened.map(item => ('secret' in item ? item.secret : item.reason));
  const expectedVersion = {
    workflow: 'code-change',
    source: { kind: 'jira-search', jql: 'project = SANDBOX AND status = "To Do"', pageSize: 25 },
    jira_start_status: 'In Progress',
    jira_end_status: 'Done',
    ignore_later_reviews: true,
    every_minutes: 10,
    needs_repository: true,
    gates: ['specify'],
    last_step: null,
    version: 1,
  };
  return {
    problems: [
      ...(first.code === 0 && first.stdout === firstRun ? [] : [`the first run gave ${describeRun(first)}`]),
      ...(second.code === 0 && second.stdout === repeatRun ? [] : [`the second run gave ${describeRun(second)}`]),
      ...(isDeepStrictEqual(afterFirst, afterSecond) ? [] : [`the second run changed row counts from ${JSON.stringify(afterFirst)} to ${JSON.stringify(afterSecond)}`]),
      ...unsaved.map(row => `repository ${row.github} does not name an add_repository action in saved_by`),
      ...(isDeepStrictEqual(version, expectedVersion) ? [] : [`the routine version is ${JSON.stringify(version)}, not ${JSON.stringify(expectedVersion)}`]),
      ...(isDeepStrictEqual(repository, expectedRepository) ? [] : [`the repositories are ${JSON.stringify(repository)}, not ${JSON.stringify(expectedRepository)}`]),
      ...(isDeepStrictEqual(steps, [{ step: 'implement', instructions: 'Keep the change small.', skills: ['typescript'] }]) ? [] : [`the routine steps are ${JSON.stringify(steps)}`]),
      ...(isDeepStrictEqual(person, { id: owner, email: 'ada@example.com', jira_account_id: 'jira-ada', kind: 'person' }) ? [] : [`the person is ${JSON.stringify(person)}`]),
      ...(isDeepStrictEqual(openedTexts, [world.env['ADA_GITHUB_TOKEN'], world.secrets[0], world.env['ADA_JIRA_LOGIN']]) ? [] : ['the engine did not open the three logins to the made-up values the file named']),
      ...leaks(world.secrets, [first, second]),
    ],
    detail: `first run printed ${JSON.stringify(first.stdout)}; second printed ${JSON.stringify(second.stdout)}; row counts ${JSON.stringify(afterSecond)} after both; the repository's saved_by names its add_repository action; the version holds the Jira search, statuses, later-reviews setting, and interval, and the repository its image, fast test command, and Verify provider; the engine opened the GitHub, Codex, and Jira logins byte for byte`,
  };
}

async function dumpHoldsNoSetupSecret(world: SetupWorld): Promise<Outcome> {
  const run = await world.apply(setupFile);
  const dump = await pgDump(world.url);
  const needles = [
    ...world.secrets.flatMap((secret, index) => needlesOf(`secret ${String(index + 1)}`, Buffer.from(secret, 'utf8'), 'utf8')),
    ...['github_pat_', 'ATATT', 'eyJ'].map(prefix => ({ name: `the prefix ${prefix}`, text: prefix })),
  ];
  return {
    problems: [...(run.code === 0 ? [] : [`setup gave ${describeRun(run)}`]), ...needles.filter(needle => dump.includes(needle.text)).map(needle => `the dump holds ${needle.name}`)],
    detail: `a ${String(dump.length)}-character pg_dump after setup holds none of ${String(needles.length)} needles: the made-up logins and key as text and hex, and github_pat_, ATATT, and eyJ`,
  };
}

async function refusesInline(world: SetupWorld): Promise<Outcome> {
  const token = world.env['ADA_GITHUB_TOKEN'] ?? '';
  const plants = [
    { field: 'people[0].logins.github', says: 'Never write a login into the setup file', logins: { ...adaLogins, github: token } },
    { field: 'people[0].logins.github', says: 'Unrecognized key: "token"', logins: { ...adaLogins, github: { env: 'ADA_GITHUB_TOKEN', token } } },
    { field: 'people[0].logins.codex', says: 'and no other field', logins: { ...adaLogins, codex: { env: 'ADA_CODEX_LOGIN', file: 'ada-codex.json' } } },
    { field: 'people[0].logins', says: '"token"', logins: { ...adaLogins, token } },
  ];
  const problems: string[] = [];
  const said: string[] = [];
  for (const { field, says, logins } of plants) {
    const run = await world.apply({ ...setupFile, people: [{ ...ada, logins }] });
    if (run.code !== 1 || !run.stderr.includes(`at ${field}\n`) || !run.stderr.includes(says)) problems.push(`the plant at ${field} gave ${describeRun(run)}`);
    problems.push(...leaks(world.secrets, [run]), ...nothingWritten(await world.rows()));
    said.push(`${lineWith(run.stderr, says)} ${lineWith(run.stderr, `at ${field}`)}`);
  }
  return { problems, detail: `each of ${String(plants.length)} planted login fields, three holding the token inline, was refused by field name and wrote nothing: ${said.join(' | ')}` };
}

async function refreshNeedsSetupMark(world: SetupWorld): Promise<Outcome> {
  const unmarked = await world.apply({ ...setupFile, people: [{ ...ada, logins: { ...adaLogins, codex: { file: 'ada-codex.json' } } }] });
  const written = await world.rows();
  const marked = await world.apply(setupFile);
  const codexRow = await world.engine
    .selectFrom('credential')
    .innerJoin('human_action', 'human_action.id', 'credential.action_id')
    .select(['credential.person_id', 'credential.expires_at', 'human_action.detail'])
    .where('credential.connector', '=', 'codex')
    .executeTakeFirst();
  return {
    problems: [
      ...(unmarked.code === 1 && unmarked.stderr.includes('at people[0].logins.codex\n') && unmarked.stderr.includes('refresh token') ? [] : [`the unmarked login gave ${describeRun(unmarked)}`]),
      ...nothingWritten(written),
      ...(marked.code === 0 && marked.stdout.includes('logins 3 sealed') ? [] : [`the marked login gave ${describeRun(marked)}`]),
      ...(isDeepStrictEqual(codexRow?.detail, { owner: codexRow?.person_id, madeForAutoWorker: true }) ? [] : [`the stored Codex login records ${JSON.stringify(codexRow?.detail)}`]),
      ...(codexRow?.expires_at?.getTime() === day(30).getTime() ? [] : [`the stored Codex login expires ${codexRow?.expires_at?.toISOString() ?? 'never'}`]),
      ...leaks(world.secrets, [unmarked, marked]),
    ],
    detail: `unmarked, setup refused it and wrote nothing; marked, it was stored as made for AutoWorker and so refreshable, expiring at its access token's exp. The refusal: ${lineWith(unmarked.stderr, 'refresh token')}`,
  };
}

async function replacementRecorded(world: SetupWorld): Promise<Outcome> {
  await world.apply(setupFile);
  const token = fakeGithubToken();
  const before = Date.now();
  const run = await world.apply(setupFile, { ...world.env, ADA_GITHUB_TOKEN: token });
  const after = Date.now();
  const actions = await world.engine.selectFrom('human_action').select(['id', 'person_id', 'at', 'connector']).where('kind', '=', 'replace_credential').orderBy('at').execute();
  const credential = await world.engine.selectFrom('credential').select(['action_id', 'person_id']).where('connector', '=', 'github').executeTakeFirstOrThrow();
  const latest = actions.at(-1);
  const opened = await open(world.engine, sealingKey(world.env), { connector: 'github', owner: credential.person_id });
  const at = latest?.at.getTime() ?? 0;
  return {
    problems: [
      ...(run.code === 0 && run.stdout.includes('logins 1 sealed') ? [] : [`the second apply gave ${describeRun(run)}`]),
      ...(actions.length === 4 ? [] : [`${String(actions.length)} replace_credential actions are recorded, not 4`]),
      ...(latest?.connector === 'github' && latest.person_id === credential.person_id && latest.id === credential.action_id ? [] : ['the GitHub credential does not cite the newest replacement, made by Ada']),
      ...(at >= before && at <= after ? [] : [`the newest replacement is recorded at ${latest?.at.toISOString() ?? 'no time'}, outside the run`]),
      ...('secret' in opened && opened.secret === token ? [] : ['the engine did not open the replaced token']),
      ...leaks([...world.secrets, token], [run]),
    ],
    detail: `a new made-up token sealed 1 login and recorded replace_credential ${latest?.id ?? ''} by person ${latest?.person_id ?? ''} at ${latest?.at.toISOString() ?? ''}, which the credential cites`,
  };
}

async function reapplyKeepsRefreshed(world: SetupWorld): Promise<Outcome> {
  const first = await world.apply(setupFile);
  const key = sealingKey(world.env);
  const { id: owner } = await world.engine.selectFrom('person').select('id').executeTakeFirstOrThrow();
  const slot: Slot = { connector: 'codex', owner };
  const opened = await open(world.engine, key, slot);
  if (!('secret' in opened)) throw new Error(`setup stored no Codex login: ${opened.reason}`);
  const refreshed = fakeLogin(day(31), fakeRefreshToken());
  const written = await writeBack(world.engine, key, { credential: opened.credential, replacement: opened.replacement, expiresAt: opened.expiresAt, slot }, refreshed.text);
  const again = await world.apply(setupFile);
  const kept = await open(world.engine, key, slot);
  const replaced = await world.apply(setupFile, world.env, ['--replace-logins']);
  const back = await open(world.engine, key, slot);
  const textOf = (found: Opened): string => ('secret' in found ? found.secret : found.reason);
  const keptLine = "logins 1 kept, because the stored login expires later than the one the file names. Run setup with --replace-logins to store the file's login anyway.";
  return {
    problems: [
      ...(first.code === 0 && first.stdout === firstRun ? [] : [`the first apply gave ${describeRun(first)}`]),
      ...(written.written ? [] : [`the refresh was not written back: ${written.reason}`]),
      ...(again.code === 0 && again.stdout.includes('logins 0 sealed\n') && again.stdout.includes(keptLine) ? [] : [`the same file applied again gave ${describeRun(again)}`]),
      ...(textOf(kept) === refreshed.text ? [] : ['applying the same file again rolled the refreshed Codex login back to the older one in the file']),
      ...(replaced.code === 0 && replaced.stdout.includes('logins 1 sealed\n') && !replaced.stdout.includes('kept') ? [] : [`--replace-logins gave ${describeRun(replaced)}`]),
      ...(textOf(back) === world.secrets[0] ? [] : ['--replace-logins did not store the Codex login the file names']),
      ...leaks([...world.secrets, refreshed.text, ...refreshed.tokens], [first, again, replaced]),
    ],
    detail: `after the engine wrote back a login expiring ${day(31).toISOString()}, the same file sealed nothing and said: ${lineWith(again.stdout, 'kept')} With --replace-logins, setup sealed the file's login, expiring ${day(30).toISOString()}`,
  };
}

async function convergesOnChanges(world: SetupWorld): Promise<Outcome> {
  await world.apply(setupFile);
  const changed = {
    ...setupFile,
    people: [{ ...ada, name: 'Ada Lovelace' }],
    repositories: [{ ...sandboxRepository, fastTestCommand: 'npm run test:fast' }],
    routines: [{ ...sandboxRoutine, gates: [], lastStep: 'implement', ignoreLaterReviews: false }],
  };
  const run = await world.apply(changed);
  const again = await world.apply(changed);
  const versions = await world.engine.selectFrom('routine_version').select(['version', sql<string[]>`gates::text[]`.as('gates'), 'last_step', 'ignore_later_reviews']).orderBy('version').execute();
  const actions = await world.engine.selectFrom('human_action').select('id').where('kind', '=', 'edit_routine').execute();
  const names = await world.engine.selectFrom('person').select('name').execute();
  const repository = await world.engine
    .selectFrom('repository')
    .innerJoin('human_action', 'human_action.id', 'repository.saved_by')
    .innerJoin('person', 'person.id', 'human_action.person_id')
    .select(['repository.job_image', 'repository.fast_test_command', 'repository.verify_provider', 'human_action.kind', 'person.email'])
    .execute();
  const repositoryActions = await world.engine.selectFrom('human_action').select('kind').where('repository_id', 'is not', null).orderBy('at').execute();
  const expected = [
    { version: 1, gates: ['specify'], last_step: null, ignore_later_reviews: true },
    { version: 2, gates: [], last_step: 'implement', ignore_later_reviews: false },
  ];
  const expectedRepository = [{ job_image: null, fast_test_command: 'npm run test:fast', verify_provider: 'tests-only', kind: 'edit_repository', email: 'ada@example.com' }];
  const changedRun = ['people 0 added, 1 changed', 'team accounts 0 added, 0 changed', 'logins 0 sealed', 'repositories 0 added, 1 changed', 'routines 0 added, 1 changed', ''].join('\n');
  return {
    problems: [
      ...(run.code === 0 && run.stdout === changedRun ? [] : [`the changed file gave ${describeRun(run)}`]),
      ...(again.code === 0 && again.stdout === repeatRun ? [] : [`the changed file applied again gave ${describeRun(again)}`]),
      ...(isDeepStrictEqual(versions, expected) ? [] : [`the routine versions are ${JSON.stringify(versions)}`]),
      ...(actions.length === 2 ? [] : [`${String(actions.length)} edit_routine actions are recorded, not 2`]),
      ...(isDeepStrictEqual(names, [{ name: 'Ada Lovelace' }]) ? [] : [`the people are ${JSON.stringify(names)}`]),
      ...(isDeepStrictEqual(repository, expectedRepository) ? [] : [`the repository is ${JSON.stringify(repository)}, not ${JSON.stringify(expectedRepository)}`]),
      ...(isDeepStrictEqual(repositoryActions, [{ kind: 'add_repository' }, { kind: 'edit_repository' }]) ? [] : [`the repository actions are ${JSON.stringify(repositoryActions)}`]),
    ],
    detail: `a renamed person, a repository with no image and another fast test command, and a routine with other gates, last step, and later-reviews setting printed ${JSON.stringify(run.stdout)}; the repository now cites Ada's edit_repository action, the routine kept version 1 and gained version 2 under a second edit_routine action, and the same file again changed nothing`,
  };
}

async function refusesBadSettings(world: SetupWorld): Promise<Outcome> {
  const { jql, ...noJql } = sandboxRoutine.source;
  const scheduled = { ...sandboxRoutine, source: { kind: 'schedule' }, jiraStartStatus: undefined, jiraEndStatus: undefined };
  const plants = [
    { field: 'routines[0].source.jql', says: 'must hold the JQL query', routine: { ...sandboxRoutine, source: noJql } },
    { field: 'routines[0].source.jql', says: 'belongs only to a jira-search source', routine: { ...scheduled, source: { kind: 'schedule', jql } } },
    { field: 'routines[0].source.pageSize', says: 'Too big', routine: { ...sandboxRoutine, source: { ...sandboxRoutine.source, pageSize: 101 } } },
    { field: 'routines[0].source.kind', says: 'only a jira-search source finds', routine: { ...scheduled, jiraEndStatus: 'Done' } },
    { field: 'routines[0].jiraStartStatus', says: 'must not be blank', routine: { ...sandboxRoutine, jiraStartStatus: ' ' } },
    { field: 'repositories[0].image', says: 'sha256 digest', repository: { ...sandboxSettings, image: 'registry.example.com/sandbox-job:latest' } },
    { field: 'repositories[0].fastTestCommand', says: 'must not be blank', repository: { ...sandboxSettings, fastTestCommand: '' } },
    { field: 'repositories[0].verifyProvider', says: 'lowercase letters', repository: { ...sandboxSettings, verifyProvider: 'Tests Only' } },
    { field: 'repositories[0].verifyProvider', says: 'names the Verify provider preview-env, which this engine was not given. Use one of: tests-only', repository: { ...sandboxSettings, verifyProvider: 'preview-env' } },
    { field: 'repositories[0]', says: 'Unrecognized key: "reviewers"', repository: { ...sandboxSettings, reviewers: ['bot'] } },
    { field: 'repositories[0].draftLeaves', says: 'Invalid option', repository: { ...sandboxSettings, draftLeaves: 'never' } },
  ];
  const problems: string[] = [];
  const said: string[] = [];
  for (const plant of plants) {
    const run = await world.apply({ ...setupFile, repositories: ['repository' in plant ? plant.repository : sandboxSettings], routines: ['routine' in plant ? plant.routine : sandboxRoutine] });
    if (run.code !== 1 || !run.stderr.includes(`at ${plant.field}\n`) || !run.stderr.includes(plant.says)) problems.push(`the plant at ${plant.field} gave ${describeRun(run)}`);
    problems.push(...nothingWritten(await world.rows()));
    said.push(`${lineWith(run.stderr, plant.says)} ${lineWith(run.stderr, `at ${plant.field}`)}`);
  }
  return { problems, detail: `each of ${String(plants.length)} planted routine and repository settings was refused by field name and wrote nothing: ${said.join(' | ')}` };
}

async function refusesUnknownRunAs(world: SetupWorld): Promise<Outcome> {
  const run = await world.apply({ ...setupFile, routines: [{ ...sandboxRoutine, runAs: 'cy@example.com' }] });
  return {
    problems: [
      ...(run.code === 1 && run.stderr.includes('at routines[0].runAs\n') && run.stderr.includes('cy@example.com') ? [] : [`setup gave ${describeRun(run)}`]),
      ...nothingWritten(await world.rows()),
    ],
    detail: `refused before any write: ${lineWith(run.stderr, 'cy@example.com')}`,
  };
}

async function duplicateAccountRollsBack(world: SetupWorld): Promise<Outcome> {
  const run = await world.apply({ ...setupFile, people: [ada, { ...ada, name: 'Bo', email: 'bo@example.com' }] });
  return {
    problems: [
      ...(run.code === 1 && run.stderr.includes('one_person_per_jira_account') && run.stdout === '' ? [] : [`setup gave ${describeRun(run)}`]),
      ...nothingWritten(await world.rows()),
    ],
    detail: `Postgres refused the second person and the people section rolled back: ${run.stderr.trim()}`,
  };
}

async function dashboardCannotReadSetupLogins(world: SetupWorld): Promise<Outcome> {
  const run = await world.apply(setupFile);
  const login = `dashboard_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const address = new URL(world.url);
  address.username = login;
  address.password = password;
  await sql`create role ${sql.id(login)} login password ${sql.lit(password)} in role dashboard`.execute(world.engine);
  const dashboard = connect(address.toString(), 1);
  try {
    const visible = await dashboard.selectFrom('credential').select(['id', 'connector']).execute();
    const sealed = await dashboard
      .selectFrom('credential')
      .select('ciphertext')
      .execute()
      .then(
        () => 'returned rows',
        (error: unknown) => messageOf(error),
      );
    return {
      problems: [
        ...(run.code === 0 ? [] : [`setup gave ${describeRun(run)}`]),
        ...(visible.length === 3 ? [] : [`the dashboard role sees ${String(visible.length)} credentials, not 3`]),
        ...(sealed.startsWith('permission denied') ? [] : [`selecting ciphertext as the dashboard role ${sealed}`]),
      ],
      detail: `the dashboard role lists ${String(visible.length)} set-up credentials, and selecting ciphertext answers: ${sealed}`,
    };
  } finally {
    await dashboard.destroy();
    await sql`drop role if exists ${sql.id(login)}`.execute(world.engine);
  }
}

function setupSpeed(postgres: TestPostgres): Promise<Outcome> {
  return inSetupWorld(postgres, async repeated => {
    const seeded = await repeated.apply(setupFile);
    const fresh: number[] = [];
    const repeats: number[] = [];
    const problems: string[] = seeded.code === 0 ? [] : [`the first apply gave ${describeRun(seeded)}`];
    for (let index = 0; index < setupBudget.runs; index += 1) {
      const run = await inSetupWorld(postgres, world => world.apply(setupFile));
      if (run.stdout !== firstRun) problems.push(`a fresh apply gave ${describeRun(run)}`);
      fresh.push(run.ms);
      const again = await repeated.apply(setupFile);
      if (again.stdout !== repeatRun) problems.push(`a repeat apply gave ${describeRun(again)}`);
      repeats.push(again.ms);
    }
    const shown = (values: readonly number[]): string => values.map(ms => ms.toFixed(0)).join(', ');
    return {
      problems: [
        ...problems,
        ...fresh.filter(ms => ms > setupBudget.freshMs).map(ms => `a fresh apply took ${ms.toFixed(0)} ms, over ${String(setupBudget.freshMs)}`),
        ...repeats.filter(ms => ms > setupBudget.repeatMs).map(ms => `a repeat apply took ${ms.toFixed(0)} ms, over ${String(setupBudget.repeatMs)}`),
      ],
      detail: `fresh applies ${shown(fresh)} ms (median ${median(fresh).toFixed(0)}, budget ${String(setupBudget.freshMs)}); repeat applies ${shown(repeats)} ms (median ${median(repeats).toFixed(0)}, budget ${String(setupBudget.repeatMs)}), each timing the whole node process`,
    };
  });
}

const setupChecks: readonly Entry[] = [
  { name: 'a first apply adds 1 person, seals 3 logins, adds 1 repository and 1 routine, and a second apply changes nothing', run: inSetup(appliesOnce) },
  { name: 'pg_dump after setup holds no made-up login, no key, and no github_pat_, ATATT, or eyJ', run: inSetup(dumpHoldsNoSetupSecret) },
  { name: 'a token written inline is refused by field name, and nothing is written', run: inSetup(refusesInline) },
  { name: 'a Codex login with a refresh token is refused unless the file marks it made for AutoWorker', run: inSetup(refreshNeedsSetupMark) },
  { name: 'a changed login is sealed again, and its replace_credential action records who and when', run: inSetup(replacementRecorded) },
  { name: "the same file applied again keeps a Codex login the engine refreshed since, and --replace-logins stores the file's login anyway", run: inSetup(reapplyKeepsRefreshed) },
  { name: 'a changed person and repository are updated, a changed routine saves a new version beside the old one, and a repeat changes nothing', run: inSetup(convergesOnChanges) },
  { name: 'a Jira search without JQL, a tagged image, a blank command or status, an unknown Verify provider, and an unknown repository field are refused by field name, and nothing is written', run: inSetup(refusesBadSettings) },
  { name: 'a run-as person the file does not list is refused by name, and nothing is written', run: inSetup(refusesUnknownRunAs) },
  { name: 'two people with one Jira account id are refused by Postgres, and the people section rolls back', run: inSetup(duplicateAccountRollsBack) },
  { name: 'after setup, the dashboard role cannot select a sealed column', run: inSetup(dashboardCannotReadSetupLogins) },
  {
    name: `a fresh apply takes at most ${String(setupBudget.freshMs)} ms and a repeat apply at most ${String(setupBudget.repeatMs)} ms, over ${String(setupBudget.runs)} of each`,
    run: setupSpeed,
  },
];

async function settle(name: string, work: () => Promise<Outcome>): Promise<Check> {
  try {
    const { problems, detail } = await work();
    return problems.length === 0 ? pass(name, detail) : fail(name, problems.join('; '));
  } catch (error) {
    return fail(name, messageOf(error));
  }
}

async function runEntries(postgres: TestPostgres, entries: readonly Entry[]): Promise<readonly Check[]> {
  const checks: Check[] = [];
  for (const { name, run } of entries) checks.push(await settle(name, () => run(postgres)));
  return checks;
}

const root = fileURLToPath(new URL('../../', import.meta.url));

const flags = { mutant: { type: 'string' } } as const;

const options = z.object({ mutant: mutantOption.optional() });

function parseOptions(args: readonly string[]): z.infer<typeof options> {
  const parsed = options.safeParse(parseArgs({ args: [...args], options: flags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const simulationFlags = { seeds: { type: 'string' }, from: { type: 'string' }, seed: { type: 'string' }, steps: { type: 'string' }, checkers: { type: 'string' }, mutant: { type: 'string' } } as const;

const whole = z.coerce.number().int().positive();

const simulationOptions = z.object({
  seeds: whole.default(200),
  from: whole.default(1),
  seed: whole.optional(),
  steps: whole.default(150),
  checkers: whole.default(3),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

const mutantSeeds = 20;

const seedList = (options: SimulationOptions, count: number): readonly number[] =>
  options.seed === undefined ? Array.from({ length: count }, (_, index) => options.from + index) : [options.seed];

const replayOf = (run: Run): string =>
  `npm run verify -- credentials-sim --seed ${String(run.seed)} --steps ${String(run.plan.steps)} --checkers ${String(run.plan.checkers)}${run.plan.mutant === undefined ? '' : ` --mutant ${run.plan.mutant}`}`;

const failureOf = (run: Run): string =>
  run.failure === undefined
    ? ''
    : `seed ${String(run.seed)} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after "${run.failure.move}" (${JSON.stringify(run.failure.broken[0]?.row)}); replay with ${replayOf(run)}; last moves: ${run.log.slice(-6).join(' | ')}`;

async function cleanSeeds(postgres: TestPostgres, options: SimulationOptions): Promise<readonly Check[]> {
  const plan: Plan = { seeds: seedList(options, options.seeds), steps: options.steps, checkers: options.checkers };
  const started = performance.now();
  const runs = await simulate(postgres, [plan]);
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const idle = runs.filter(run => run.refreshed === 0);
  const sum = (pick: (run: Run) => number): number => runs.reduce((total, run) => total + pick(run), 0);
  const name = `${String(runs.length)} seeds, ${String(failed.length)} violations`;
  return [
    failed.length === 0
      ? pass(name, `${String(options.checkers)} checkers, ${String(options.steps)} steps a seed, in ${seconds.toFixed(1)} s: ${String(sum(run => run.refreshed))} refreshes written back, ${String(sum(run => run.interrupted))} interrupted refreshes caught, ${String(sum(run => run.crashes))} checkers crashed mid-check, ${String(sum(run => run.jobs))} jobs given a login`)
      : fail(name, failed.slice(0, 3).map(failureOf).join('; ')),
    idle.length === 0
      ? pass('every seed wrote at least one refreshed login back', `fewest refreshes in a seed: ${String(Math.min(...runs.map(run => run.refreshed)))}`)
      : fail('every seed wrote at least one refreshed login back', `seeds ${idle.map(run => String(run.seed)).join(', ')} refreshed nothing`),
  ];
}

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const expected: readonly string[] = mutants[mutant].breaks;
  const runs = await simulate(postgres, [{ seeds: seedList(options, Math.min(options.seeds, mutantSeeds)), steps: options.steps, checkers: options.checkers, mutant }]);
  const breaking = runs.filter(run => run.failure?.broken.some(found => expected.includes(found.property)) === true);
  const name = `${expected.join(' or ')} fails under the ${mutant} mutant`;
  const first = breaking[0];
  return first === undefined ? fail(name, `no seed of ${String(runs.length)} broke it`) : pass(name, `${String(breaking.length)} of ${String(runs.length)} seeds; first: ${failureOf(first)}`);
}

async function plantChecks(postgres: TestPostgres): Promise<Check> {
  const proofs = await provePlants(postgres);
  const wrong = proofs.filter(proof => proof.atStart.length > 0 || !proof.reported.includes(proof.property));
  const name = 'each property reports its planted violation, and nothing before it';
  return wrong.length === 0 ? pass(name, `${String(proofs.length)} plants: ${proofs.map(proof => proof.property).join(', ')}`) : fail(name, JSON.stringify(wrong));
}

async function catalogCheck(postgres: TestPostgres): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    const { rows } = await sql<{ name: string }>`
      select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid = 'credential_check'::regclass and not (c.contype = 'p' and c.conname = t.relname || '_pkey') and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
      union all
      select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
      where x.indrelid = 'credential_check'::regclass and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union all
      select g.tgname from pg_trigger g where g.tgrelid = 'credential_check'::regclass and not g.tgisinternal`.execute(db);
    const guards = rows.map(row => row.name);
    const dropped = Object.values(mutants).flatMap(({ drop }) => (drop === undefined ? [] : 'index' in drop ? [drop.index] : drop.on === 'credential_check' ? [drop.trigger] : []));
    const listed = [...dropped, ...Object.values(noMutantYet).flat()];
    const problems = [...guards.filter(guard => !listed.includes(guard)).map(guard => `${guard} is in neither list`), ...listed.filter(name => !guards.includes(name)).map(name => `${name} is listed, but credential_check has no such guard`)];
    const name = 'every named constraint, index, and trigger on credential_check has a mutant or a reason in noMutantYet';
    return problems.length === 0 ? pass(name, guards.join(', ')) : fail(name, problems.join('; '));
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function simulationChecks(postgres: TestPostgres, options: SimulationOptions): Promise<readonly Check[]> {
  if (options.mutant === 'all') {
    const checks: Check[] = [await plantChecks(postgres), await catalogCheck(postgres)];
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
    return checks;
  }
  if (options.mutant !== undefined) return [await mutantCheck(postgres, options.mutant, options)];
  return [...(await cleanSeeds(postgres, options)), await plantChecks(postgres), ...(await laneChecks(postgres))];
}

const engineMain = join(root, 'services', 'engine', 'main.ts');

const expiryHeader = '2026-12-31 23:59:59 UTC';

async function fakeGithub(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/user' ? 200 : 404, { 'content-type': 'application/json', 'github-authentication-token-expiration': expiryHeader });
    response.end(JSON.stringify({ login: 'ada' }));
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake GitHub server has no port');
  return { url: `http://127.0.0.1:${String(address.port)}`, close: () =>
      new Promise(done => {
        server.close(() => {
          done();
        });
      }),
  };
}

async function engineChecksGithub(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  const github = await fakeGithub();
  const keyText = randomBytes(32).toString('base64');
  const key = sealingKey({ CREDENTIAL_KEY: keyText, CREDENTIAL_KEY_VERSION: '1' });
  try {
    const { id: ada } = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada', kind: 'person' }).returning('id').executeTakeFirstOrThrow();
    const stored = await replace(db, key, { action: randomUUID(), by: ada, at: new Date(), owner: ada, secret: { connector: 'github', token: fakeGithubToken() } });
    if ('refused' in stored) throw new Error(stored.reason);
    const env = { ...process.env, DATABASE_URL: scratch.url, CREDENTIAL_KEY: keyText, CREDENTIAL_KEY_VERSION: '1', CHECKS_EVERY_MS: '500', GITHUB_API_URL: github.url };
    const leftover = await mkdtemp(join(tmpdir(), codexHomePrefix));
    await writeFile(join(leftover, 'auth.json'), 'a login a crashed check left behind');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(leftover, anHourAgo, anHourAgo);
    const child = spawn(process.execPath, [engineMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>(done => {
      child.on('exit', code => {
        done(code);
      });
    });
    const deadline = performance.now() + 20_000;
    while (!said.includes('checks: checked the github credential') && performance.now() < deadline) await new Promise(done => setTimeout(done, 50));
    child.kill('SIGTERM');
    const code = await exited;
    const leftoverGone = await access(leftover).then(
      () => false,
      () => true,
    );
    await rm(leftover, { recursive: true, force: true });
    const row = await db.selectFrom('credential').select(['state', 'checked_at', 'expires_at']).where('id', '=', stored.credential).executeTakeFirstOrThrow();
    const checks = await db.selectFrom('credential_check').select(['outcome', 'checker']).where('credential_id', '=', stored.credential).execute();
    const short = spawnSync(process.execPath, [engineMain], { env: { ...env, CREDENTIAL_KEY: randomBytes(31).toString('base64') }, encoding: 'utf8', timeout: 20_000 });
    const expected = new Date(Date.parse(expiryHeader.replace(' UTC', 'Z').replace(' ', 'T'))).toISOString();
    const recorded = { state: row.state, checked: row.checked_at !== null, expiresAt: row.expires_at?.toISOString() ?? null, outcomes: checks.map(check => check.outcome) };
    const ranName = 'the engine process checks a stored GitHub token on its checks loop, records valid with the expiry header, and exits 0 on SIGTERM';
    const shortName = 'the engine refuses to start with a 31-byte CREDENTIAL_KEY and names the variable';
    const leftoverName = 'when its checks loop starts, the engine removes a Codex home an hour old that a crashed check left behind';
    return [
      code === 0 && isDeepStrictEqual(recorded, { state: 'valid', checked: true, expiresAt: expected, outcomes: ['valid'] })
        ? pass(ranName, `${JSON.stringify(recorded)}; checker ${checks[0]?.checker ?? 'none'}`)
        : fail(ranName, `exit ${String(code)}, recorded ${JSON.stringify(recorded)}; the engine said: ${said.trim().replaceAll('\n', ' | ')}`),
      short.status === 1 && short.stderr.includes('CREDENTIAL_KEY') ? pass(shortName, short.stderr.trim()) : fail(shortName, `exit ${String(short.status)}: ${short.stdout}${short.stderr}`),
      leftoverGone && said.includes(`checks: removed ${leftover}`)
        ? pass(leftoverName, lineWith(said, 'checks: removed'))
        : fail(leftoverName, `${leftover} ${leftoverGone ? 'is gone' : 'is still there'}; the engine said: ${said.trim().replaceAll('\n', ' | ')}`),
    ];
  } finally {
    await github.close();
    await db.destroy();
    await scratch.drop();
  }
}

const refusedImage = `registry.example.com/job@sha256:${'b'.repeat(64)}`;

const refusals: readonly { readonly setting: string; readonly because: string; readonly env: Readonly<Record<string, string>> }[] = [
  { setting: 'CREDENTIAL_KEY', because: 'JOB_IMAGE is set without it', env: { JOB_IMAGE: refusedImage, JOB_ENGINE_URL: 'http://engine.example.com/' } },
  { setting: 'JOB_ENGINE_URL', because: 'JOB_IMAGE is set without it', env: { JOB_IMAGE: refusedImage, CREDENTIAL_KEY: randomBytes(32).toString('base64'), CREDENTIAL_KEY_VERSION: '1' } },
  { setting: 'CREDENTIAL_KEY', because: 'CREDENTIAL_KEY_VERSION is set without it', env: { CREDENTIAL_KEY_VERSION: '1' } },
  { setting: 'ATTEMPT_START_LEASE_MS', because: 'the start lease of 300000 ms is not above the environment start deadline plus the Codex check timeout', env: { ATTEMPT_START_LEASE_MS: '300000' } },
];

const unrelatedTo = (names: readonly string[]): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.some(prefix => name.startsWith(prefix))));

function engineRefusals(): readonly Check[] {
  const quiet = unrelatedTo(['CREDENTIAL_', 'JOB_', 'ATTEMPT_', 'ENVIRONMENT_', 'CHECK_', 'DATABASE_']);
  const closedUrl = 'postgres://autoworker:not-a-real-password@127.0.0.1:1/autoworker';
  const refused = refusals.map(({ setting, because, env }) => {
    const run = spawnSync(process.execPath, [engineMain], { env: { ...quiet, DATABASE_URL: closedUrl, ...env }, encoding: 'utf8', timeout: 20_000 });
    const name = `the engine refuses to start and names ${setting} when ${because}`;
    const secrets = Object.values(env).filter(value => value.length > 20);
    return run.status === 1 && run.stderr.includes(`at ${setting}`) && !secrets.some(secret => run.stderr.includes(secret))
      ? pass(name, run.stderr.trim().replaceAll('\n', ' '))
      : fail(name, `exit ${String(run.status)}: ${run.stdout}${run.stderr}`);
  });
  const closed = spawnSync(process.execPath, [engineMain], { env: { ...quiet, DATABASE_URL: closedUrl, DATABASE_CONNECT_TIMEOUT_MS: '3000' }, encoding: 'utf8', timeout: 30_000 });
  const closedName = "with Postgres unreachable, the engine exits 1 with one line naming DATABASE_URL's host and no stack trace or password";
  const readable = closed.status === 1 && closed.stderr.includes('127.0.0.1:1') && closed.stderr.includes('DATABASE_URL') && !/^s+at /m.test(closed.stderr) && !closed.stderr.includes('not-a-real-password');
  return [...refused, readable ? pass(closedName, closed.stderr.trim()) : fail(closedName, `exit ${String(closed.status)}: ${closed.stdout}${closed.stderr}`)];
}

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export const scenarios: readonly Scenario[] = [
  checksModel,
  ...liveScenarios,
  {
    name: 'engine-checks',
    summary: "starts the engine's entry point with a sealing key against Postgres and a fake GitHub API, waits for its checks loop to record a stored token valid and remove a leftover Codex home, and proves it refuses settings that do not fit together and an unreachable Postgres by name",
    run: async () => [...engineRefusals(), ...(await withPostgres(engineChecksGithub))],
  },
  {
    name: 'credentials-sim',
    summary:
      'runs several engine checkers against real Postgres and a fake token issuer that refuses a reused refresh token, crashes them mid-refresh, and checks every property of the Checks model after each step; --mutant all proves each guard can fail',
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
  {
    name: 'credentials',
    summary: 'stores credentials sealed with AES-256-GCM in real Postgres and proves the dashboard role can neither read one back nor write one except through replace_credential; --mutant all proves each guard and each missing grant can fail',
    run: args => {
      const { mutant } = parseOptions(args);
      return withPostgres(postgres => runEntries(postgres, mutant === undefined ? storeChecks : mutantEntries(mutant)));
    },
  },
  {
    name: 'setup',
    summary:
      'runs node services/engine/setup.ts as a child process against fresh Postgres databases with made-up logins, and proves it applies a file once, refuses inline tokens and unmarked refreshable Codex logins, records each replacement, never prints or stores a secret in the clear, and stays within its time budget',
    run: () => withPostgres(postgres => runEntries(postgres, setupChecks)),
  },
];

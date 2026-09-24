import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { sql } from 'kysely';
import { getContainerRuntimeClient } from 'testcontainers';
import ts from 'typescript';
import { z } from 'zod';
import { connect } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { provePlants } from './invariants.ts';
import type { Secret } from './kinds.ts';
import { checksModel } from './checks-model.ts';
import { liveScenarios } from './live.ts';
import { mutantName, mutants, noMutantYet, simulate, type MutantName, type Plan, type Run } from './simulate.ts';
import { mutantEntries, mutantOption } from './mutants.ts';
import { seal, sealingKey, unseal } from './seal.ts';
import { expiring, open, replace, type Replaced, type Replacement, type Slot } from './store.ts';
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
  { name: 'tsc rejects a Checks record that misses a connector kind, and a raw login where AccessOnlyLogin is required', run: offline(typeGuards) },
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

function typeErrors(planted: string): readonly string[] {
  const file = join(root, 'features', 'credentials', 'planted.ts');
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error('tsconfig.json did not parse');
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = path => (resolve(path) === file ? planted : readFile(path));
  host.fileExists = path => resolve(path) === file || fileExists(path);
  const program = ts.createProgram([file], parsed.options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

type TypePlant = { readonly what: string; readonly source: string; readonly rejectedWith: string | undefined };

const giveToJob = "import { accessOnly, type AccessOnlyLogin } from './kinds.ts';\nconst launch = (login: AccessOnlyLogin): string => login;\n";

const typePlants: readonly TypePlant[] = [
  {
    what: 'a Checks record with no check for github',
    source: "import type { Checks } from './checks.ts';\nexport const planted: Checks = { codex: { rotates: () => false, run: () => Promise.reject(new Error('planted')) } };\n",
    rejectedWith: "Property 'github' is missing",
  },
  {
    what: 'a Checks record with a check for every kind',
    source:
      "import type { Checks } from './checks.ts';\nimport type { Check } from './kinds.ts';\nconst check: Check = { rotates: () => false, run: () => Promise.reject(new Error('planted')) };\nexport const planted: Checks = { codex: check, github: check };\n",
    rejectedWith: undefined,
  },
  {
    what: 'a raw login passed where AccessOnlyLogin is required',
    source: `${giveToJob}export const planted = launch('{"tokens": {"refresh_token": "rt"}}');\nexport const made = accessOnly;\n`,
    rejectedWith: `is not assignable to parameter of type 'string & $brand<"AccessOnlyLogin">'`,
  },
  {
    what: 'a login that accessOnly made, passed where AccessOnlyLogin is required',
    source: `${giveToJob}const copy = accessOnly('{}');\nexport const planted = 'login' in copy ? launch(copy.login) : copy.reason;\n`,
    rejectedWith: undefined,
  },
];

function typeGuards(): Outcome {
  const problems = typePlants.flatMap(({ what, source, rejectedWith }) => {
    const errors = typeErrors(source);
    if (rejectedWith === undefined) return errors.length === 0 ? [] : [`tsc rejected ${what}: ${errors.join('; ')}`];
    return errors.some(error => error.includes(rejectedWith)) ? [] : [`tsc did not reject ${what} with "${rejectedWith}"; it said ${errors.length === 0 ? 'nothing' : errors.join('; ')}`];
  });
  return { problems, detail: typePlants.map(plant => `${plant.what}: ${plant.rejectedWith === undefined ? 'accepted' : 'rejected'}`).join('; ') };
}

const flags = { mutant: { type: 'string' } } as const;

const options = z.object({ mutant: mutantOption.optional() });

function parseOptions(args: readonly string[]): z.infer<typeof options> {
  const parsed = options.safeParse(parseArgs({ args: [...args], options: flags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const simulationFlags = { seeds: { type: 'string' }, seed: { type: 'string' }, steps: { type: 'string' }, checkers: { type: 'string' }, mutant: { type: 'string' } } as const;

const whole = z.coerce.number().int().positive();

const simulationOptions = z.object({
  seeds: whole.default(200),
  seed: whole.optional(),
  steps: whole.default(150),
  checkers: whole.default(3),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

const mutantSeeds = 20;

const seedList = (options: SimulationOptions, count: number): readonly number[] =>
  options.seed === undefined ? Array.from({ length: count }, (_, index) => index + 1) : [options.seed];

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
      where x.indrelid = 'credential_check'::regclass and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))`.execute(db);
    const guards = rows.map(row => row.name);
    const listed = [...Object.values(mutants).flatMap(mutant => (mutant.dropIndex === undefined ? [] : [mutant.dropIndex])), ...Object.values(noMutantYet).flat()];
    const problems = [...guards.filter(guard => !listed.includes(guard)).map(guard => `${guard} is in neither list`), ...listed.filter(name => !guards.includes(name)).map(name => `${name} is listed, but credential_check has no such guard`)];
    const name = 'every named constraint and index on credential_check has a mutant or a reason in noMutantYet';
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
  return [...(await cleanSeeds(postgres, options)), await plantChecks(postgres)];
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
    const row = await db.selectFrom('credential').select(['state', 'checked_at', 'expires_at']).where('id', '=', stored.credential).executeTakeFirstOrThrow();
    const checks = await db.selectFrom('credential_check').select(['outcome', 'checker']).where('credential_id', '=', stored.credential).execute();
    const short = spawnSync(process.execPath, [engineMain], { env: { ...env, CREDENTIAL_KEY: randomBytes(31).toString('base64') }, encoding: 'utf8', timeout: 20_000 });
    const expected = new Date(Date.parse(expiryHeader.replace(' UTC', 'Z').replace(' ', 'T'))).toISOString();
    const recorded = { state: row.state, checked: row.checked_at !== null, expiresAt: row.expires_at?.toISOString() ?? null, outcomes: checks.map(check => check.outcome) };
    const ranName = 'the engine process checks a stored GitHub token on its checks loop, records valid with the expiry header, and exits 0 on SIGTERM';
    const shortName = 'the engine refuses to start with a 31-byte CREDENTIAL_KEY and names the variable';
    return [
      code === 0 && isDeepStrictEqual(recorded, { state: 'valid', checked: true, expiresAt: expected, outcomes: ['valid'] })
        ? pass(ranName, `${JSON.stringify(recorded)}; checker ${checks[0]?.checker ?? 'none'}`)
        : fail(ranName, `exit ${String(code)}, recorded ${JSON.stringify(recorded)}; the engine said: ${said.trim().replaceAll('\n', ' | ')}`),
      short.status === 1 && short.stderr.includes('CREDENTIAL_KEY') ? pass(shortName, short.stderr.trim()) : fail(shortName, `exit ${String(short.status)}: ${short.stdout}${short.stderr}`),
    ];
  } finally {
    await github.close();
    await db.destroy();
    await scratch.drop();
  }
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
    summary: "starts the engine's entry point with a sealing key against Postgres and a fake GitHub API, and waits for its checks loop to record a stored token valid",
    run: () => withPostgres(engineChecksGithub),
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
];

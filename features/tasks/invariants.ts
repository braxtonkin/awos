import { expressionBuilder, sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { DB } from '../../shared/db/types.ts';
import type { Workflow } from '../../shared/workflow.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { caps } from './claim.ts';
import { nobodyToRunAs, runAs } from './run-as.ts';

type Moment = 'each-step' | 'after-quiet-phase';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement; readonly checkedAtSeconds?: number };

type Property = { readonly moment: Moment; readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

const t0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

const plantedAt = Date.parse('2026-01-01T00:00:00.000Z');

const plantedEveryMs = 15_000;

const plantCheckedAtSeconds = 60;

const firstAction = sql.lit('00000000-0000-4000-8000-000000000001');

const world: readonly Statement[] = [
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${t0}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values (${firstAction}, ${t0}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository, gates)
      values (1, 1, 'Plants', 'Break one property at a time.', 1, ${firstAction}, 'code-change', '{"kind": "jira-search"}', true, '{specify}')`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (1, 1, 1, 'PLANT-1', 'Plant', ${t0}, 'acc-ada', 'code-change', true, 'specify')`,
];

const nobodyCanRunTheTask: readonly Statement[] = [
  sql`update routine set run_as_id = null where id = 1`,
  sql`update task set assignee_account_id = 'acc-nobody' where id = 1`,
];

const waitingForAPerson = sql.lit(nobodyToRunAs);

const liveAttempt = sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
  values (1, 1, 1, 'specify', 0, 1, ${t0} + interval '1 second', ${t0} + interval '31 seconds')`;

const liveAttemptAsNobody = sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
  values (1, 1, 1, 'specify', 0, null, ${t0} + interval '1 second', ${t0} + interval '31 seconds')`;

const finishedAttempt = (step: string, verdict: 'pass' | 'lost') => sql`insert into attempt
  (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until, finished_at, verdict, output)
  values (1, 1, 1, ${sql.lit(step)}, 0, 1, ${t0}, ${t0} + interval '30 seconds', ${t0} + interval '10 seconds', ${sql.lit(verdict)},
          ${verdict === 'pass' ? sql`'{"outcome": "done", "summary": "Planted.", "blocks": []}'` : sql`null`})`;

const plantedReview = sql`'{"outcome": "done", "summary": "Planted.", "blocks": []}'`;

const atLand: readonly Statement[] = [
  finishedAttempt('specify', 'pass'),
  finishedAttempt('implement', 'pass'),
  finishedAttempt('verify', 'pass'),
  sql`update task set step = 'land', approved = '{specify}' where id = 1`,
];

const liveAttemptAtLand = sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
  values (1, 1, 1, 'land', 0, 1, ${t0} + interval '11 seconds', ${t0} + interval '41 seconds')`;

const personActs =(kind: 'stop_task' | 'retry_task', id: string) =>
  sql`insert into human_action (id, at, person_id, kind, task_id) values (${sql.lit(id)}, ${t0} + interval '2 seconds', 1, ${sql.lit(kind)}, 1)`;

const personApproves = (id: string, attempt: number) =>
  sql`insert into human_action (id, at, person_id, kind, task_id, attempt_id) values (${sql.lit(id)}, ${t0} + interval '20 seconds', 1, 'approve', 1, ${sql.lit(attempt)})`;

const gatedAt = (step: string) =>
  sql`update task set step = ${sql.lit(step)}, state = 'waiting', waiting_on = 'approval', waiting_reason = 'Approve it.',
      review_attempt = (select max(a.id) from attempt a where a.task_id = 1) where id = 1`;

const record = sql`s.step, s.state, s.waiting_on, s.retries, s.lost, s.input_waits, s.counts, s.approved, s.outputs`;

const wasRecord = sql`s.was_step, s.was_state, s.was_waiting_on, s.was_retries, s.was_lost, s.was_input_waits, s.was_counts, s.was_approved, s.was_outputs`;

const reviewKinds = sql`('approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft')`;

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select t.id, t.step, t.retries, t.lost, t.input_waits, t.counts from task t
      where least(t.retries, t.lost, t.input_waits) < 0
        or exists (select 1 from jsonb_each(t.counts) c where jsonb_typeof(c.value) <> 'number' or (c.value)::int < 0)
        or not exists (select 1 from facts f where f.workflow = t.workflow and f.step = t.step)`,
    plants: [
      { setup: [], violation: sql`update task set lost = -1 where id = 1` },
      { setup: [], violation: sql`update task set counts = '{"rounds": -1}' where id = 1` },
    ],
  },
  OneLiveAttempt: {
    moment: 'each-step',
    breaks: sql`select task_id, array_agg(id order by id) as live from attempt where finished_at is null group by task_id having count(*) > 1`,
    plants: [{ setup: [sql`drop index one_live_attempt_per_task`, liveAttempt], violation: liveAttempt }],
  },
  LiveAttemptMeansReady: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, t.state
      from attempt a join task t on t.id = a.task_id
      where a.finished_at is null and t.state <> 'ready'`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt],
        violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = 'Planted.' where id = 1`,
      },
    ],
  },
  LiveAttemptIsCurrent: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.epoch as claimed_at, t.epoch as now_at
      from attempt a join task t on t.id = a.task_id
      where a.finished_at is null and a.epoch <> t.epoch`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt],
        violation: sql`update task set epoch = epoch + 1 where id = 1`,
      },
    ],
  },
  AttemptRunsAsAPerson: {
    moment: 'each-step',
    breaks: sql`select id, task_id from attempt where run_as_id is null`,
    plants: [{ setup: [sql`alter table attempt drop constraint attempt_runs_as_a_person`], violation: liveAttemptAsNobody }],
  },
  LiveAttemptWorksTheTaskStep: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, a.step as attempt_step, t.step
      from attempt a join task t on t.id = a.task_id
      where a.finished_at is null and a.step <> t.step`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt],
        violation: sql`update task set step = 'implement' where id = 1`,
      },
    ],
  },
  OutputsSurvive: {
    moment: 'each-step',
    breaks: sql`select t.id, f.step as missing
      from task t
      join facts fh on fh.workflow = t.workflow and fh.step = t.step
      join facts f on f.workflow = t.workflow and f.position < fh.position
      where not exists (select 1 from attempt a where a.task_id = t.id and a.step = f.step and a.verdict = 'pass')`,
    plants: [{ setup: [], violation: sql`update task set step = 'implement' where id = 1` }],
  },
  RoundsCapped: {
    moment: 'each-step',
    breaks: sql`select t.id, c.counter, t.counts ->> c.counter as count
      from task t join charges c on c.workflow = t.workflow and c.kind = 'return'
      where coalesce((t.counts ->> c.counter)::int, 0) > c.cap`,
    plants: [
      { setup: [], violation: sql`update task set counts = '{"rounds": 4}' where id = 1` },
      { setup: [], violation: sql`update task set counts = '{"landRounds": 4}' where id = 1` },
    ],
  },
  EnvRerunsCapped: {
    moment: 'each-step',
    breaks: sql`select t.id, c.counter, t.counts ->> c.counter as count
      from task t join charges c on c.workflow = t.workflow and c.kind = 'rerun'
      where coalesce((t.counts ->> c.counter)::int, 0) > c.cap`,
    plants: [{ setup: [], violation: sql`update task set counts = '{"reruns": 4}' where id = 1` }],
  },
  ReviewReturnsCapped: {
    moment: 'each-step',
    breaks: sql`select t.id, c.counter, t.counts ->> c.counter as count
      from task t join charges c on c.workflow = t.workflow and c.kind = 'review'
      where coalesce((t.counts ->> c.counter)::int, 0) > c.cap`,
    plants: [{ setup: [], violation: sql`update task set counts = '{"reviews": 2}' where id = 1` }],
  },
  LostAttemptsCapped: {
    moment: 'each-step',
    breaks: sql`select id, lost from task where lost > ${sql.lit(caps.lost)}`,
    plants: [{ setup: [], violation: sql`update task set lost = ${sql.lit(caps.lost + 1)} where id = 1` }],
  },
  StageRetriesCapped: {
    moment: 'each-step',
    breaks: sql`select id, retries from task where retries > ${sql.lit(caps.stageRetries)}`,
    plants: [{ setup: [], violation: sql`update task set retries = ${sql.lit(caps.stageRetries + 1)} where id = 1` }],
  },
  InputWaitsCapped: {
    moment: 'each-step',
    breaks: sql`select id, input_waits from task where input_waits > ${sql.lit(caps.inputWaits)}`,
    plants: [{ setup: [], violation: sql`update task set input_waits = ${sql.lit(caps.inputWaits + 1)} where id = 1` }],
  },
  PassLeavesNoStageRetries: {
    moment: 'each-step',
    breaks: sql`select t.id, t.retries, latest.id as attempt
      from task t
      cross join lateral (
        select a.id, a.verdict from attempt a
        where a.task_id = t.id and a.finished_at is not null
        order by a.finished_at desc, a.id desc
        limit 1
      ) latest
      where t.retries > 0 and latest.verdict = 'pass'`,
    plants: [{ setup: [finishedAttempt('specify', 'pass')], violation: sql`update task set retries = 1 where id = 1` }],
  },
  StopsAtItsEndStage: {
    moment: 'each-step',
    breaks: sql`select t.id, t.step, t.state, v.end_step
      from task t
      join versions v on v.id = t.id
      join facts fh on fh.workflow = t.workflow and fh.step = t.step
      join facts fe on fe.workflow = t.workflow and fe.step = v.end_step
      where fh.position > fe.position or (t.state = 'done' and t.step <> v.end_step)`,
    plants: [{ setup: [], violation: sql`update task set state = 'done' where id = 1` }],
  },
  ApprovalsMatchGatesPassed: {
    moment: 'each-step',
    breaks: sql`select t.id, t.approved, v.gates
      from task t
      join versions v on v.id = t.id
      join facts fh on fh.workflow = t.workflow and fh.step = t.step
      cross join lateral (
        select array(select a::text from unnest(t.approved) a order by 1) as approved,
               array(select g from unnest(v.gates) g join facts f on f.workflow = t.workflow and f.step = g where f.position < fh.position order by g) as passed
      ) held
      where case when fh.irreversible then not (held.approved <@ held.passed) else held.approved is distinct from held.passed end`,
    plants: [
      { setup: [], violation: sql`update task set approved = '{specify}' where id = 1` },
      { setup: atLand, violation: sql`update task set approved = '{implement,specify}' where id = 1` },
    ],
  },
  StoppedTaskCanResume: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_step, s.step, s.was_approved, s.approved from diff s
      where s.id in (select task_id from acted) and s.was_state = 'stopped' and s.state = 'ready'
        and (s.step <> s.was_step
             or s.approved is distinct from s.was_approved
             or not (s.was_outputs <@ s.outputs)
             or exists (select 1 from charges c where c.workflow = s.workflow and c.kind = 'review'
                        and (s.counts ->> c.counter) is distinct from (s.was_counts ->> c.counter)))`,
    plants: [
      {
        setup: [
          finishedAttempt('specify', 'pass'),
          sql`update task set step = 'implement', approved = '{specify}' where id = 1`,
          personActs('stop_task', '00000000-0000-4000-8000-000000000006'),
          sql`update task set state = 'stopped', stopped_by = '00000000-0000-4000-8000-000000000006' where id = 1`,
        ],
        violation: sql`with retried as (insert into human_action (id, at, person_id, kind, task_id)
                         values ('00000000-0000-4000-8000-000000000007', ${t0} + interval '3 seconds', 1, 'retry_task', 1) returning task_id)
                       update task set state = 'ready', stopped_by = null, approved = '{}' from retried where task.id = retried.task_id`,
      },
    ],
  },
  ApproveNamesTheWaitingReview: {
    moment: 'each-step',
    breaks: sql`select h.id, h.kind, h.attempt_id, s.was_latest, s.was_waiting_on
      from acted h join diff s on s.id = h.task_id
      where h.kind in ${reviewKinds} and not (s.was_waiting_on in ('approval', 'answer') and h.attempt_id is not distinct from s.was_latest)`,
    plants: [
      {
        setup: [finishedAttempt('specify', 'pass'), finishedAttempt('specify', 'pass'), gatedAt('specify')],
        violation: personApproves('00000000-0000-4000-8000-000000000008', 1),
      },
    ],
  },
  TaskHasItsRepository: {
    moment: 'each-step',
    breaks: sql`select t.id, t.key, t.workflow from task t
      where t.repository_id is null and exists (select 1 from facts f where f.workflow = t.workflow and f.needs_repository)`,
    plants: [
      {
        setup: [sql`alter table task drop constraint task_repository_when_needed`],
        violation: sql`update task set repository_id = null where id = 1`,
      },
    ],
  },
  SendBackCarriesItsNote: {
    moment: 'each-step',
    breaks: sql`select h.id, h.detail from acted h where h.kind = 'send_back' and btrim(coalesce(h.detail ->> 'note', '')) = ''`,
    plants: [
      {
        setup: [sql`alter table human_action drop constraint send_back_has_a_note`, finishedAttempt('specify', 'pass'), gatedAt('specify')],
        violation: sql`insert into human_action (id, at, person_id, kind, task_id, attempt_id)
          values ('00000000-0000-4000-8000-00000000000a', ${t0} + interval '20 seconds', 1, 'send_back', 1, 1)`,
      },
    ],
  },
  ActionHasOneTarget: {
    moment: 'each-step',
    breaks: sql`select h.id, h.kind from targeted h where num_nonnulls(h.routine_id, h.task_id, h.repository_id, h.connector) <> 1`,
    plants: [
      {
        setup: [sql`alter table human_action drop constraint one_target`],
        violation: sql`insert into human_action (id, at, person_id, kind, routine_id, connector)
          values ('00000000-0000-4000-8000-00000000000b', ${t0} + interval '20 seconds', 1, 'edit_routine', 1, 'github')`,
      },
      {
        setup: [sql`alter table human_action drop constraint one_target`],
        violation: sql`insert into human_action (id, at, person_id, kind, routine_id, repository_id)
          values ('00000000-0000-4000-8000-00000000000c', ${t0} + interval '20 seconds', 1, 'edit_routine', 1, 1)`,
      },
    ],
  },
  ActionTargetFitsItsKind: {
    moment: 'each-step',
    breaks: sql`select h.id, h.kind from targeted h where not coalesce(case
        when h.kind in ('stop_task', 'retry_task', 'approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft') then h.task_id is not null
        when h.kind in ('add_repository', 'edit_repository') then h.repository_id is not null
        when h.kind = 'replace_credential' then h.connector is not null
        else h.routine_id is not null
      end, false)`,
    plants: [
      {
        setup: [sql`alter table human_action drop constraint target_fits_kind`],
        violation: sql`insert into human_action (id, at, person_id, kind, repository_id)
          values ('00000000-0000-4000-8000-00000000000d', ${t0} + interval '20 seconds', 1, 'replace_credential', 1)`,
      },
      {
        setup: [sql`alter table human_action drop constraint target_fits_kind`],
        violation: sql`insert into human_action (id, at, person_id, kind, connector)
          values ('00000000-0000-4000-8000-00000000000e', ${t0} + interval '20 seconds', 1, 'add_repository', 'codex')`,
      },
    ],
  },
  LateWriteChangesNothing: {
    moment: 'each-step',
    breaks: sql`select w.id, w.verdict, w.finished_at from written w, prior p where w.id <= p.max_attempt and w.id <> all(p.live)`,
    plants: [
      {
        setup: [sql`drop trigger finished_attempt_is_final on attempt`, finishedAttempt('specify', 'lost')],
        violation: sql`update attempt set verdict = 'pass', output = '{}' where id = 1`,
      },
    ],
  },
  TaskChangesOnlyWithItsAttempt: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_state, s.state, s.was_step, s.step from diff s
      where (${record}) is distinct from (${wasRecord})
        and s.id not in (select task_id from ended)
        and s.id not in (select task_id from acted)
        and not (s.was_state = 'ready' and s.state = 'waiting' and s.waiting_on = 'retry' and s.waiting_reason = ${waitingForAPerson}
                 and not s.was_live and s.runs_as is null
                 and (s.step, s.retries, s.lost, s.input_waits, s.counts, s.approved, s.outputs)
                     = (s.was_step, s.was_retries, s.was_lost, s.was_input_waits, s.was_counts, s.was_approved, s.was_outputs))
        and not (s.was_state = 'waiting' and s.was_waiting_on = 'outside_approval' and s.state = 'ready'
                 and (s.step, s.retries, s.lost, s.input_waits, s.counts, s.approved, s.outputs)
                     = (s.was_step, s.was_retries, s.was_lost, s.was_input_waits, s.was_counts, s.was_approved, s.was_outputs))
        and not (exists (select 1 from facts f where f.workflow = s.workflow and f.step = s.was_step and f.irreversible) and s.approved = '{}'
                 and (s.step, s.state, s.waiting_on, s.retries, s.lost, s.input_waits, s.counts, s.outputs)
                     is not distinct from (s.was_step, s.was_state, s.was_waiting_on, s.was_retries, s.was_lost, s.was_input_waits, s.was_counts, s.was_outputs))`,
    plants: [
      { setup: [], violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = ${waitingForAPerson} where id = 1` },
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt, ...nobodyCanRunTheTask],
        violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = ${waitingForAPerson} where id = 1`,
      },
      {
        setup: [
          personActs('stop_task', '00000000-0000-4000-8000-000000000005'),
          sql`update task set state = 'stopped', stopped_by = '00000000-0000-4000-8000-000000000005' where id = 1`,
          ...nobodyCanRunTheTask,
        ],
        violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = ${waitingForAPerson}, stopped_by = null where id = 1`,
      },
      { setup: nobodyCanRunTheTask, violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = ${waitingForAPerson}, lost = 1 where id = 1` },
      { setup: nobodyCanRunTheTask, violation: sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = 'Planted.' where id = 1` },
      {
        setup: [sql`update task set state = 'waiting', waiting_on = 'outside_approval', waiting_reason = 'Planted.' where id = 1`],
        violation: sql`update task set state = 'ready', waiting_on = null, waiting_reason = null, retries = 1 where id = 1`,
      },
      {
        setup: [finishedAttempt('specify', 'pass'), sql`update task set step = 'implement', approved = '{specify}' where id = 1`],
        violation: sql`update task set approved = '{}' where id = 1`,
      },
      { setup: atLand, violation: sql`update task set approved = '{}', retries = 1 where id = 1` },
    ],
  },
  AttemptEndsOnlyWithItsTask: {
    moment: 'each-step',
    breaks: sql`select e.id as attempt, e.task_id from ended e join diff s on s.id = e.task_id
      where (${record}) is not distinct from (${wasRecord}) and e.task_id not in (select task_id from acted)`,
    plants: [{ setup: [liveAttempt], violation: sql`update attempt set finished_at = ${t0} + interval '5 seconds', verdict = 'fail', output = '{}' where id = 1` }],
  },
  FailedRoundReturnsToImplement: {
    moment: 'each-step',
    breaks: sql`select s.id, c.counter, s.step, s.state from diff s
      join charges c on c.workflow = s.workflow and c.kind = 'return'
      where coalesce((s.counts ->> c.counter)::int, 0) > coalesce((s.was_counts ->> c.counter)::int, 0)
        and not (s.step = c.to_step or s.state = 'waiting')`,
    plants: [
      { setup: [], violation: sql`update task set counts = '{"rounds": 1}' where id = 1` },
      {
        setup: [finishedAttempt('specify', 'pass'), finishedAttempt('implement', 'pass'), finishedAttempt('verify', 'pass'), sql`update task set step = 'land', approved = '{specify}' where id = 1`],
        violation: sql`update task set counts = '{"landRounds": 1}' where id = 1`,
      },
    ],
  },
  OutputsOnlyGrow: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_outputs, s.outputs from diff s where not (s.was_outputs <@ s.outputs)`,
    plants: [
      {
        setup: [sql`drop trigger finished_attempt_is_final on attempt`, finishedAttempt('specify', 'pass')],
        violation: sql`update attempt set verdict = 'lost', output = null where id = 1`,
      },
    ],
  },
  StageAdvancesOnlyOnPass: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_step, s.step, s.was_state, s.state from diff s
      join facts fb on fb.workflow = s.workflow and fb.step = s.was_step
      join facts fa on fa.workflow = s.workflow and fa.step = s.step
      where (fa.position > fb.position or (s.state = 'done' and s.was_state <> 'done'))
        and not exists (select 1 from ended e where e.task_id = s.id and e.verdict = 'pass')
        and not (s.id in (select task_id from acted where kind = 'approve') and s.was_latest_verdict = 'pass')`,
    plants: [{ setup: [finishedAttempt('specify', 'pass')], violation: sql`update task set step = 'implement' where id = 1` }],
  },
  DoneIsFinal: {
    moment: 'each-step',
    breaks: sql`select s.id, s.step, s.state from diff s where s.was_state = 'done' and (${record}) is distinct from (${wasRecord})`,
    plants: [
      {
        setup: [
          sql`drop trigger done_task_is_final on task`,
          finishedAttempt('specify', 'pass'),
          finishedAttempt('implement', 'pass'),
          finishedAttempt('verify', 'pass'),
          finishedAttempt('land', 'pass'),
          sql`update task set step = 'land', state = 'done', approved = '{specify}' where id = 1`,
        ],
        violation: sql`update task set state = 'ready' where id = 1`,
      },
    ],
  },
  StageMovesOneStep: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_step, s.step from diff s
      join facts fb on fb.workflow = s.workflow and fb.step = s.was_step
      join facts fa on fa.workflow = s.workflow and fa.step = s.step
      where s.step <> s.was_step and fa.position <> fb.position + 1
        and not exists (select 1 from charges c where c.workflow = s.workflow and c.step = s.was_step and c.to_step = s.step)`,
    plants: [
      {
        setup: [finishedAttempt('specify', 'pass'), finishedAttempt('implement', 'pass')],
        violation: sql`update task set step = 'verify', approved = '{specify}' where id = 1`,
      },
    ],
  },
  OnlyAPersonStops: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_state from diff s
      where s.state = 'stopped' and s.was_state <> 'stopped' and s.id not in (select task_id from acted)`,
    plants: [
      {
        setup: [personActs('stop_task', '00000000-0000-4000-8000-000000000003')],
        violation: sql`update task set state = 'stopped', stopped_by = '00000000-0000-4000-8000-000000000003' where id = 1`,
      },
    ],
  },
  RetryLeavesNoStageRetries: {
    moment: 'each-step',
    breaks: sql`select s.id, s.retries from diff s where s.id in (select task_id from acted) and s.state = 'ready' and s.retries > 0`,
    plants: [{ setup: [sql`update task set retries = 1 where id = 1`], violation: personActs('retry_task', '00000000-0000-4000-8000-000000000004') }],
  },
  GatePassesOnlyOnApprove: {
    moment: 'each-step',
    breaks: sql`select s.id, g.gate from diff s
      join versions v on v.id = s.id
      cross join lateral unnest(v.gates) as g(gate)
      join facts fg on fg.workflow = s.workflow and fg.step = g.gate
      join facts fb on fb.workflow = s.workflow and fb.step = s.was_step
      join facts fa on fa.workflow = s.workflow and fa.step = s.step
      where fb.position <= fg.position and fa.position > fg.position
        and not (s.id in (select task_id from acted where kind = 'approve') and g.gate = any(s.approved))`,
    plants: [
      {
        setup: [finishedAttempt('specify', 'pass')],
        violation: sql`update task set step = 'implement', approved = '{specify}' where id = 1`,
      },
    ],
  },
  MergeNeedsEveryGate: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_approved, v.gates from diff s
      join versions v on v.id = s.id
      join facts fb on fb.workflow = s.workflow and fb.step = s.was_step
      where fb.irreversible and s.was_state <> 'done' and s.state = 'done'
        and not (exists (select 1 from ended e where e.task_id = s.id and e.verdict = 'pass') and v.gates <@ s.was_approved)`,
    plants: [
      {
        setup: [
          finishedAttempt('specify', 'pass'),
          finishedAttempt('implement', 'pass'),
          finishedAttempt('verify', 'pass'),
          sql`update task set step = 'land', approved = '{specify}' where id = 1`,
        ],
        violation: sql`update task set state = 'done' where id = 1`,
      },
    ],
  },
  ReleasedWithinOneInterval: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, a.lease_until, checked_at as released_by
      from attempt a, prior p, engine e
      where a.id = any(p.live) and a.verdict = 'lost' and checked_at - a.lease_until > make_interval(secs => e.every_ms / 1000.0)`,
    plants: [{ setup: [liveAttempt], violation: sql`update attempt set finished_at = ${t0} + interval '60 seconds', verdict = 'lost' where id = 1` }],
  },
  ReleasedOnlyAfterItsLease: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, a.lease_until, checked_at as released_by
      from attempt a, prior p
      where a.id = any(p.live) and a.verdict = 'lost' and a.lease_until >= checked_at`,
    plants: [{ setup: [liveAttempt], violation: sql`update attempt set finished_at = ${t0} + interval '20 seconds', verdict = 'lost' where id = 1`, checkedAtSeconds: 20 }],
  },
  ReviewsOnlyGrow: {
    moment: 'each-step',
    breaks: sql`select s.id, c.counter, s.was_counts ->> c.counter as was, s.counts ->> c.counter as count
      from diff s join charges c on c.workflow = s.workflow and c.kind = 'review'
      where coalesce((s.counts ->> c.counter)::int, 0) < coalesce((s.was_counts ->> c.counter)::int, 0)`,
    plants: [{ setup: [sql`update task set counts = '{"reviews": 1}' where id = 1`], violation: sql`update task set counts = '{}' where id = 1` }],
  },
  LaterReviewWaitsForAPerson: {
    moment: 'each-step',
    breaks: sql`select s.id, s.state, s.waiting_on, v.ignore_later_reviews from diff s
      join ended e on e.task_id = s.id and e.verdict = 'changes_requested'
      join charges c on c.workflow = s.workflow and c.step = s.was_step and c.kind = 'review'
      join task t on t.id = s.id
      join routine_version v on v.routine_id = t.routine_id and v.version = t.found_version
      where coalesce((s.was_counts ->> c.counter)::int, 0) >= c.cap
        and (s.state = 'waiting' and s.waiting_on = 'retry') = v.ignore_later_reviews`,
    plants: [
      {
        setup: [...atLand, sql`update task set counts = '{"reviews": 1}' where id = 1`, liveAttemptAtLand],
        violation: sql`update attempt set finished_at = ${t0} + interval '12 seconds', verdict = 'changes_requested', output = ${plantedReview} where finished_at is null`,
      },
    ],
  },
  EndStagePassIsDone: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_step, s.state from diff s
      join versions v on v.id = s.id
      join ended e on e.task_id = s.id and e.verdict = 'pass'
      where s.was_step = v.end_step and v.gates <@ s.was_approved and s.state <> 'done'`,
    plants: [
      {
        setup: [...atLand, liveAttemptAtLand],
        violation: sql`update attempt set finished_at = ${t0} + interval '12 seconds', verdict = 'pass', output = ${plantedReview} where finished_at is null`,
      },
    ],
  },
  EveryTaskSettles: {
    moment: 'after-quiet-phase',
    breaks: sql`select id, step, state from task where state = 'ready'`,
    plants: [
      {
        setup: [sql`update task set state = 'waiting', waiting_on = 'retry', waiting_reason = 'Planted.' where id = 1`],
        violation: sql`update task set state = 'ready', waiting_on = null, waiting_reason = null where id = 1`,
      },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type Watch = {
  readonly atStart: readonly Violation[];
  readonly step: (checkedAt: Date) => Promise<readonly Violation[]>;
  readonly settled: () => Promise<readonly Violation[]>;
};

export type PlantProof = {
  readonly property: PropertyName;
  readonly plant: number;
  readonly atStart: readonly PropertyName[];
  readonly reported: readonly PropertyName[];
};

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

const propertyNames = Object.keys(properties).filter(isPropertyName);

const branches = (moment: Moment) =>
  sql.join(
    propertyNames
      .filter(name => properties[name].moment === moment)
      .map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

function workflowFacts(workflows: readonly Workflow[]): Statement {
  const steps = workflows.flatMap(workflow =>
    workflow.steps.map(
      (kind, index) =>
        sql`(${sql.lit(workflow.name)}, ${sql.lit(kind.name)}, ${sql.lit(index + 1)}, ${sql.lit(index === workflow.steps.length - 1)}, ${sql.lit(kind.owes.some(owed => owed.irreversible))}, ${sql.lit(kind.needsRepository)})`,
    ),
  );
  const charges = workflows.flatMap(workflow =>
    workflow.steps.flatMap(kind =>
      Object.values(kind.failures).flatMap(failure =>
        !('counter' in failure)
          ? []
          : [sql`(${sql.lit(workflow.name)}, ${sql.lit(kind.name)}, ${sql.lit(failure.kind)}, ${sql.lit(failure.counter)}, ${sql.lit(failure.cap)}, ${'to' in failure ? sql.lit(failure.to) : sql`null::text`})`],
      ),
    ),
  );
  const chargeRows = charges.length === 0 ? sql`select null::text, null::text, null::text, null::text, null::int, null::text where false` : sql`values ${sql.join(charges)}`;
  return sql`
    facts (workflow, step, position, is_last, irreversible, needs_repository) as (values ${sql.join(steps)}),
    charges (workflow, step, kind, counter, cap, to_step) as (${chargeRows}),`;
}

const helpers = (workflows: readonly Workflow[], everyMs: number) => sql`
  ${workflowFacts(workflows)}
  engine (every_ms) as (values (${sql.lit(everyMs)}::int)),
  prior as (
    select (before->>'xid')::xid as xid, (before->>'maxAttempt')::bigint as max_attempt,
           array(select jsonb_array_elements_text(before->'live')::bigint) as live
    where before is not null),
  versions as (
    select t.id, v.gates::text[] as gates, coalesce(v.last_step::text, (select f.step from facts f where f.workflow = t.workflow and f.is_last)) as end_step
    from task t join routine_version v on v.routine_id = t.routine_id and v.version = t.found_version),
  record as (
    select task.id, task.workflow, task.step, task.state, task.waiting_on, task.retries, task.lost, task.input_waits, task.counts,
           array(select a::text from unnest(task.approved) a order by 1) as approved,
           array(select distinct a.step::text from attempt a where a.task_id = task.id and a.verdict = 'pass' order by 1) as outputs,
           latest.id as latest, latest.verdict as latest_verdict,
           task.waiting_reason,
           ${runAs(expressionBuilder<DB, 'task'>())} as runs_as
    from task
    left join lateral (
      select a.id, a.verdict from attempt a where a.task_id = task.id and a.finished_at is not null order by a.id desc limit 1
    ) latest on true),
  was as (
    select * from jsonb_to_recordset(coalesce(before->'tasks', '[]'))
      as w(id bigint, step text, state task_state, waiting_on waiting_on, retries int, lost int, input_waits int, counts jsonb,
           approved text[], outputs text[], latest bigint, latest_verdict verdict)),
  written as (select a.* from attempt a, prior p where age(a.xmin) < age(p.xid)),
  ended as (select a.task_id, a.id, a.verdict from attempt a, prior p where a.finished_at is not null and a.id = any(p.live)),
  acted as (select h.id, h.task_id, h.kind, h.attempt_id, h.detail from human_action h, prior p where h.task_id is not null and age(h.xmin) < age(p.xid)),
  targeted as (select h.id, h.kind, h.routine_id, h.task_id, h.repository_id, h.connector from human_action h, prior p where age(h.xmin) < age(p.xid)),
  diff as (
    select r.id, r.workflow, w.step as was_step, r.step, w.state as was_state, r.state, w.waiting_on as was_waiting_on, r.waiting_on,
           w.retries as was_retries, r.retries, w.lost as was_lost, r.lost, w.input_waits as was_input_waits, r.input_waits,
           w.counts as was_counts, r.counts, w.approved as was_approved, r.approved, w.outputs as was_outputs, r.outputs,
           w.latest as was_latest, w.latest_verdict as was_latest_verdict, r.waiting_reason,
           exists (select 1 from attempt a, prior p where a.task_id = r.id and a.id = any(p.live)) as was_live,
           r.runs_as
    from record r join was w on w.id = r.id)`;

const install = (workflows: readonly Workflow[], everyMs: number) => sql`
  create function check_step(before jsonb, checked_at timestamptz) returns jsonb language plpgsql as $check$
  declare
    own constant xid := pg_current_xact_id()::xid;
    deadline constant timestamptz := clock_timestamp() + interval '1 second';
  begin
    loop
      perform pg_stat_clear_snapshot();
      exit when not exists (select 1 from pg_stat_activity
                            where datname = current_database() and backend_type = 'client backend' and age(backend_xid) > age(own));
      if clock_timestamp() > deadline then
        raise exception 'check_step reads xmin, which is sound only when every transaction older than the check has ended, and one in this database was still open after a second';
      end if;
      perform pg_sleep(0.001);
    end loop;
    return (
      with ${helpers(workflows, everyMs)}
      select jsonb_build_object(
        'violations', coalesce((select jsonb_agg(v) from (${branches('each-step')}) v), '[]'::jsonb),
        'state', jsonb_build_object(
          'xid', own::text,
          'maxAttempt', (select max(id) from attempt),
          'live', coalesce((select jsonb_agg(id) from attempt where finished_at is null), '[]'::jsonb),
          'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'step', step, 'state', state, 'waiting_on', waiting_on,
            'retries', retries, 'lost', lost, 'input_waits', input_waits, 'counts', counts, 'approved', approved, 'outputs', outputs,
            'latest', latest, 'latest_verdict', latest_verdict)) from record), '[]'::jsonb))));
  end
  $check$`;

const violations = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const answer = z.object({ violations, state: z.json() });

export async function watch(db: Database, workflows: readonly Workflow[], everyMs: number, startedAt: Date): Promise<Watch> {
  const compiled = install(workflows, everyMs).compile(db);
  if (compiled.parameters.length > 0) {
    throw new Error(
      'check_step must compile without parameters, because a function body takes no bind parameters. Write each constant in a predicate or a run-as rule with sql.lit, since eb.lit refuses strings.',
    );
  }
  await db.executeQuery(compiled);
  let before: z.infer<typeof answer>['state'] = null;
  const step = async (checkedAt: Date): Promise<readonly Violation[]> => {
    const { rows } = await sql<{ result: unknown }>`select check_step(${before === null ? null : JSON.stringify(before)}::jsonb, ${checkedAt}::timestamptz) as result`.execute(db);
    const checked = answer.parse(rows[0]?.result);
    before = checked.state;
    return checked.violations;
  };
  const atStart = await step(startedAt);
  return {
    atStart,
    step,
    settled: async () => violations.parse((await sql`${branches('after-quiet-phase')}`.execute(db)).rows),
  };
}

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

const checksAt: Readonly<Record<Moment, (watched: Watch, checkedAt: Date) => Promise<readonly Violation[]>>> = {
  'each-step': (watched, checkedAt) => watched.step(checkedAt),
  'after-quiet-phase': watched => watched.settled(),
};

async function provePlant(postgres: TestPostgres, workflows: readonly Workflow[], moment: Moment, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...world, ...plant.setup]) await statement.execute(db);
    const checkedAt = new Date(plantedAt + (plant.checkedAtSeconds ?? plantCheckedAtSeconds) * 1000);
    const watched = await watch(db, workflows, plantedEveryMs, checkedAt);
    const atStart = await checksAt[moment](watched, checkedAt);
    await plant.violation.execute(db);
    const reported = await checksAt[moment](watched, checkedAt);
    return { atStart: namesOf(atStart), reported: namesOf(reported) };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function provePlants(postgres: TestPostgres, workflows: readonly Workflow[]): Promise<readonly PlantProof[]> {
  const proofs: PlantProof[] = [];
  for (const property of propertyNames) {
    const { moment, plants } = properties[property];
    for (const [index, plant] of plants.entries()) proofs.push({ property, plant: index + 1, ...(await provePlant(postgres, workflows, moment, plant)) });
  }
  return proofs;
}

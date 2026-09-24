import type { ColumnType } from "kysely";
import type { IPostgresInterval } from "postgres-interval";

export type AttemptCommandKind = "turn.start" | "turn.steer" | "turn.stop";

export type AttemptEventKind = "app" | "end" | "pushed";

export type CheckOutcome = "invalid" | "lost" | "unknown" | "valid";

export type ConnectorKind = "codex" | "github" | "jira";

export type ConnectorScope = "personal" | "team";

export type CredentialState = "invalid" | "unknown" | "valid";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type HumanActionKind = "add_repository" | "approve" | "edit_draft" | "edit_repository" | "edit_routine" | "pause_routine" | "pick_choice" | "replace_credential" | "resume_routine" | "retry_task" | "run_now" | "send_back" | "stop_task" | "untick_items";

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Interval = ColumnType<IPostgresInterval, IPostgresInterval | number | string, IPostgresInterval | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [x: string]: JsonValue | undefined;
};

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type OutboxState = "done" | "dropped" | "failed" | "owed" | "refused";

export type PersonKind = "person" | "shared";

export type RunOutcome = "done" | "failed" | "lost" | "paused";

export type RunReason = "run_now" | "schedule";

export type TaskState = "done" | "ready" | "stopped" | "waiting";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type Verdict = "behavior_fail" | "changes_requested" | "environment_fail" | "fail" | "lost" | "needs_input" | "pass" | "red_check" | "review_required" | "stopped";

export type WaitingOn = "answer" | "approval" | "outside_approval" | "retry";

export interface Attempt {
  branch: string | null;
  bridge_pid: number | null;
  bridge_token_hash: Buffer | null;
  commands_received: Generated<Int8>;
  epoch: number;
  finished_at: Timestamp | null;
  high_water: Generated<Int8>;
  id: Generated<Int8>;
  last_pushed: string | null;
  lease_until: Timestamp;
  live: Generated<boolean | null>;
  output: Json | null;
  routine_id: Int8;
  routine_version: number;
  run_as_id: Int8;
  start_commit: string | null;
  started_at: Timestamp;
  step: string;
  task_id: Int8;
  verdict: Verdict | null;
}

export interface AttemptCommand {
  acted_at: Timestamp | null;
  attempt_id: Int8;
  client_message_id: string | null;
  input: string | null;
  kind: AttemptCommandKind;
  output_schema: Json | null;
  received_at: Timestamp | null;
  sent_at: Timestamp;
  seq: Int8;
}

export interface AttemptEvent {
  attempt_id: Int8;
  body: Json;
  fragment: boolean;
  item_id: string | null;
  kind: AttemptEventKind;
  method: string | null;
  seq: Int8;
  stored_at: Timestamp;
}

export interface Connector {
  kind: ConnectorKind;
  scope: ConnectorScope;
}

export interface Credential {
  action_id: string;
  checked_at: Timestamp | null;
  ciphertext: Buffer;
  connector: ConnectorKind;
  expires_at: Timestamp | null;
  id: Generated<Int8>;
  key_version: number;
  person_id: Int8 | null;
  scope: ConnectorScope;
  state: CredentialState | null;
}

export interface CredentialCheck {
  cause: string | null;
  checker: string;
  claimed_at: Timestamp;
  credential_id: Int8;
  finished_at: Timestamp | null;
  id: Generated<Int8>;
  lease_until: Timestamp;
  opened_expires_at: Timestamp | null;
  outcome: CheckOutcome | null;
  refreshes: boolean;
  replacement: string;
}

export interface Evidence {
  attempt_id: Int8;
  body: Json;
  recorded_at: Timestamp;
  task_id: Int8;
}

export interface HumanAction {
  at: Timestamp;
  attempt_id: Int8 | null;
  connector: ConnectorKind | null;
  detail: Generated<Json>;
  id: string;
  kind: HumanActionKind;
  person_id: Int8;
  repository_id: Int8 | null;
  routine_id: Int8 | null;
  task_id: Int8 | null;
}

export interface Outbox {
  acts_as: Int8;
  claim: string | null;
  id: Generated<Int8>;
  idempotency_key: string;
  kind: string;
  last_error: string | null;
  lease_until: Timestamp | null;
  owed_at: Timestamp;
  payload: Json;
  position: number;
  result: Json | null;
  settled_at: Timestamp | null;
  state: Generated<OutboxState>;
  task_id: Int8;
  tries: Generated<number>;
}

export interface Person {
  email: string;
  id: Generated<Int8>;
  jira_account_id: string | null;
  kind: Generated<PersonKind>;
  name: string;
}

export interface Repository {
  branch: string;
  fast_test_command: string | null;
  github: string;
  id: Generated<Int8>;
  job_image: string | null;
  saved_by: string;
  verify_provider: Generated<string>;
}

export interface Routine {
  creator_id: Int8;
  id: Generated<Int8>;
  paused_by: string | null;
  run_as_id: Int8 | null;
}

export interface RoutineOverlap {
  routine_id: Int8;
  run_id: Int8;
  task_id: Int8;
}

export interface RoutineRun {
  claim: string | null;
  claimed_at: Timestamp | null;
  covers: Generated<number>;
  finished_at: Timestamp | null;
  finished_by: string | null;
  found: Generated<number>;
  id: Generated<Int8>;
  lease_until: Timestamp | null;
  note: string | null;
  outcome: RunOutcome | null;
  pressed_by: string | null;
  reason: RunReason;
  routine_id: Int8;
  slot: Timestamp | null;
  started_at: Timestamp | null;
  version: number;
}

export interface RoutineStep {
  instructions: Generated<string>;
  routine_id: Int8;
  skills: Generated<string[]>;
  step: string;
  version: number;
}

export interface RoutineVersion {
  action_id: string;
  every: Generated<Interval>;
  gates: Generated<string[]>;
  goal: string;
  ignore_later_reviews: Generated<boolean>;
  jira_end_status: string | null;
  jira_start_status: string | null;
  last_step: string | null;
  name: string;
  needs_repository: boolean;
  repository_id: Int8 | null;
  routine_id: Int8;
  source: Json;
  version: number;
  workflow: string;
}

export interface Task {
  approved: Generated<string[]>;
  assignee_account_id: string | null;
  counts: Generated<Json>;
  epoch: Generated<number>;
  found_at: Timestamp;
  found_version: number;
  id: Generated<Int8>;
  input_waits: Generated<number>;
  key: string;
  lost: Generated<number>;
  needs_repository: boolean;
  owed_actions: Generated<number>;
  ready: Generated<boolean | null>;
  repository_id: Int8 | null;
  retries: Generated<number>;
  review_attempt: Int8 | null;
  routine_id: Int8;
  state: Generated<TaskState>;
  step: string;
  stopped_by: string | null;
  title: string;
  waiting_on: WaitingOn | null;
  waiting_reason: string | null;
  workflow: string;
}

export interface VerifyEnvironment {
  attempt_id: Int8;
  called_at: Timestamp;
  id: Generated<Int8>;
  provider: string;
  recorded_at: Timestamp;
  result: Json | null;
  returned_at: Timestamp | null;
  starting: Generated<number>;
  stopped_at: Timestamp | null;
}

export interface DB {
  attempt: Attempt;
  attempt_command: AttemptCommand;
  attempt_event: AttemptEvent;
  connector: Connector;
  credential: Credential;
  credential_check: CredentialCheck;
  evidence: Evidence;
  human_action: HumanAction;
  outbox: Outbox;
  person: Person;
  repository: Repository;
  routine: Routine;
  routine_overlap: RoutineOverlap;
  routine_run: RoutineRun;
  routine_step: RoutineStep;
  routine_version: RoutineVersion;
  task: Task;
  verify_environment: VerifyEnvironment;
}

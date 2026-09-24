import type { ColumnType } from "kysely";

export type CheckOutcome = "invalid" | "lost" | "unknown" | "valid";

export type ConnectorKind = "codex" | "github";

export type ConnectorScope = "personal" | "team";

export type CredentialState = "invalid" | "unknown" | "valid";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type HumanActionKind = "add_repository" | "approve" | "edit_draft" | "edit_repository" | "edit_routine" | "pause_routine" | "pick_choice" | "replace_credential" | "resume_routine" | "retry_task" | "send_back" | "stop_task" | "untick_items";

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [x: string]: JsonValue | undefined;
};

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type PersonKind = "person" | "shared";

export type TaskState = "done" | "ready" | "stopped" | "waiting";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type Verdict = "behavior_fail" | "changes_requested" | "environment_fail" | "fail" | "lost" | "needs_input" | "pass" | "red_check" | "review_required" | "stopped";

export type WaitingOn = "answer" | "approval" | "outside_approval" | "retry";

export interface Attempt {
  epoch: number;
  finished_at: Timestamp | null;
  id: Generated<Int8>;
  lease_until: Timestamp;
  live: Generated<boolean | null>;
  output: Json | null;
  routine_id: Int8;
  routine_version: number;
  run_as_id: Int8;
  started_at: Timestamp;
  step: string;
  task_id: Int8;
  verdict: Verdict | null;
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

export interface Person {
  email: string;
  id: Generated<Int8>;
  jira_account_id: string | null;
  kind: Generated<PersonKind>;
  name: string;
}

export interface Repository {
  branch: string;
  github: string;
  id: Generated<Int8>;
  saved_by: string;
}

export interface Routine {
  creator_id: Int8;
  id: Generated<Int8>;
  paused_by: string | null;
  run_as_id: Int8 | null;
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
  gates: Generated<string[]>;
  goal: string;
  ignore_later_reviews: Generated<boolean>;
  last_step: string | null;
  name: string;
  needs_repository: boolean;
  repository_id: Int8 | null;
  routine_id: Int8;
  schedule: string;
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

export interface DB {
  attempt: Attempt;
  connector: Connector;
  credential: Credential;
  credential_check: CredentialCheck;
  human_action: HumanAction;
  person: Person;
  repository: Repository;
  routine: Routine;
  routine_step: RoutineStep;
  routine_version: RoutineVersion;
  task: Task;
}

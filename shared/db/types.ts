import type { ColumnType } from "kysely";

export type ConnectorKind = "codex" | "github";

export type ConnectorScope = "personal" | "team";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type HumanActionKind = "edit_routine" | "pause_routine" | "replace_credential" | "resume_routine" | "retry_task" | "stop_task";

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [x: string]: JsonValue | undefined;
};

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type PersonKind = "person" | "shared";

export type Stage = "implement" | "land" | "specify" | "verify";

export type TaskState = "done" | "ready" | "stopped" | "waiting";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type Verdict = "behavior_fail" | "environment_fail" | "fail" | "lost" | "pass" | "stopped";

export interface Attempt {
  finished_at: Timestamp | null;
  id: Generated<Int8>;
  lease_until: Timestamp;
  live: Generated<boolean | null>;
  output: Json | null;
  routine_id: Int8;
  routine_version: number;
  run_as_id: Int8;
  stage: Stage;
  started_at: Timestamp;
  task_id: Int8;
  verdict: Verdict | null;
}

export interface Connector {
  kind: ConnectorKind;
  scope: ConnectorScope;
}

export interface Credential {
  action_id: string;
  ciphertext: Buffer;
  connector: ConnectorKind;
  expires_at: Timestamp | null;
  id: Generated<Int8>;
  key_version: number;
  person_id: Int8 | null;
  scope: ConnectorScope;
}

export interface HumanAction {
  at: Timestamp;
  connector: ConnectorKind | null;
  detail: Generated<Json>;
  id: string;
  kind: HumanActionKind;
  person_id: Int8;
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
}

export interface Routine {
  creator_id: Int8;
  id: Generated<Int8>;
  paused_by: string | null;
  run_as_id: Int8 | null;
}

export interface RoutineVersion {
  action_id: string;
  goal: string;
  name: string;
  repository_id: Int8;
  routine_id: Int8;
  schedule: string;
  version: number;
}

export interface Task {
  assignee_account_id: string | null;
  found_at: Timestamp;
  found_version: number;
  id: Generated<Int8>;
  key: string;
  lost: Generated<number>;
  ready: Generated<boolean | null>;
  repository_id: Int8;
  reruns: Generated<number>;
  retries: Generated<number>;
  rounds: Generated<number>;
  routine_id: Int8;
  stage: Generated<Stage>;
  state: Generated<TaskState>;
  stopped_by: string | null;
  title: string;
  waiting_reason: string | null;
}

export interface DB {
  attempt: Attempt;
  connector: Connector;
  credential: Credential;
  human_action: HumanAction;
  person: Person;
  repository: Repository;
  routine: Routine;
  routine_version: RoutineVersion;
  task: Task;
}

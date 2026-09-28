# How to set up and operate AutoWorker

This page covers the work around the code: setting up a machine, connecting real accounts, holding AutoWorker against a real repository, reading a live task, and landing a change. [verification.md](verification.md) covers which checks to run, and [reference/scenarios.md](reference/scenarios.md) lists every scenario.

Everything except local CI and two budget commands runs inside the `verify` or `live` container, so the host needs only a few tools.

## Install the host tools

1. Install Docker with Compose v2, on an x86_64 (amd64) host. The verify image downloads x86_64 builds of the Docker CLI, kind, the Chromium headless shell, and FFmpeg, each pinned by checksum in `tools/verify/Dockerfile`, and pins Debian packages whose versions may differ on arm64. Nothing has been tried on an arm64 host.
2. Install Git.
3. Install Node 24 on the host. Local CI (`node tools/ci-local/main.ts`) and the budget's `--lower` and `--since` run on the host, because Git inside the container cannot read a worktree made on Windows.
4. From the clone's root, run `npm ci --ignore-scripts` on the host. The host tools import `zod` and `typescript`. The containers never see this `node_modules`, because each compose project mounts its own volume over `/repo/node_modules`.
5. Install the GitHub CLI, `gh`, if you open and merge pull requests from the command line.

First builds need network access to Docker Hub, the Debian and npm registries, `download.docker.com`, `cdn.playwright.dev`, and GitHub releases.

## Set up a clone or worktree

Each worktree is its own compose project, named for its folder, with its own `node_modules` volume and verify image tag. Run these from the worktree's root:

1. Create `compose.override.yaml` if you cap the cores verification uses, as the next section shows.
2. Build the verify image with `docker compose build verify`. Build it again after any change to `tools/verify/Dockerfile`.
3. Install packages with `docker compose run --rm verify npm ci`. Run it again after any change to `package-lock.json`.
4. Check the container with `docker compose run --rm verify npm run verify -- doctor`. It checks Node 24, the Docker API, and that the container can start sibling containers.
5. Run `docker compose run --rm verify npm run check`, then `docker compose run --rm verify npm test`. Both must pass on a clean `main`.

Use `docker compose run --rm -T` when no terminal is attached, for example from a script or an agent's shell.

## Cap the cores verification uses

Verification can use every core, and the models and simulators often do. To keep cores free for other work, pin the `verify` and `live` services to a set of cores in `compose.override.yaml` at the worktree's root. Compose merges the file automatically, and Git ignores it.

```yaml
services:
  verify:
    cpuset: "0-7"
  live:
    cpuset: "0-7"
```

`withPostgres` gives each Postgres it starts the same cores as the verify container, and fails when Docker reports others. Do not set `hostname:` on either service, because the tools find their own container by its host name.

## Connect the real accounts

Scenarios that reach Jira, GitHub, or Codex run in the `live` service, which reads two things from the host. Keep both out of every repository, log, and transcript.

- **`~/.autoworker/sandbox.env`.** One unquoted `KEY=value` per line: `JIRA_SITE` (an `https` address), `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `GITHUB_TOKEN`. The GitHub token must be able to push branches, open, update, and merge pull requests, and read check runs and their logs on the repositories AutoWorker works on. The end-to-end test also posts the `sandbox` commit status on its run branches.
- **`~/.autoworker/codex/auth.json`.** A Codex login with its refresh token blank, which the service mounts read-only at `/codex`. Sign in to Codex in a Codex home made for AutoWorker, copy its `auth.json`, and set `tokens.refresh_token` to an empty string. AutoWorker never refreshes this login, so replace the file before its access token expires.

Then run `docker compose run --rm live npm run verify -- accounts`. It checks the four keys and their formats, that the mounted login holds no refresh token, and that Jira and GitHub accept the tokens, and it prints no value.

Never run `docker compose config`, print a `live` container's environment, or paste a compose error about the sandbox file, because each can show the values.

## Prepare a repository and a Jira project

AutoWorker works on any GitHub repository its token can reach, with tickets from one Jira site.

- **The Jira project.** The routine moves each ticket to a start status and an end status, which the e2e test and the hold set to `In Progress` and `Done`. The project's workflow must allow both transitions. A search that ends in `AND status != Done` keeps a fresh database from redoing finished tickets.
- **The repository's base branch.** A ruleset that requires pull requests and a check lets Land see a red check and send the task back. Allow merge commits, because Land merges with a merge commit.
- **The e2e sandbox repository.** The end-to-end test writes each run to a branch `e2e/run-<id>` whose workflow defines one job, `sandbox`. Protect `e2e/run-*` with a ruleset that requires the `sandbox` status check from any source, applied at creation, because the test posts `sandbox` itself on the commits it writes through the API.
- **The repository's own ignores.** The Job commits every file the agent leaves in the workspace, so the repository's `.gitignore` must cover its scratch files. See "Each repository ignores its own scratch files" in [docs/decisions.md](../decisions.md#each-repository-ignores-its-own-scratch-files).

## Share the kind cluster

Attempt Jobs run on a local Kubernetes cluster from kind, named `autoworker` and pinned in `tools/verify/kind.yaml`. Every worktree on the machine shares it.

- Start a lane that needs the cluster with `npm run verify -- kind up` in the same container, as in `docker compose run --rm live sh -c 'npm run verify -- kind up && npm run verify -- <scenario>'`. The container's place on the `kind` network and the kubeconfig that `kind up` writes last only as long as the container.
- `kind up` reuses a running cluster whose node runs the pinned image, recreates a stopped one, and fails on a node with another image.
- `kind down` deletes the cluster for every worktree. Run it only when no other lane uses the cluster.
- The tools also start a registry, `autoworker-registry`, on the `kind` network and publish it on the host at `127.0.0.1:5001`. The kind node pulls `127.0.0.1:5001/...` images from it. The registry and the cluster stay up between runs by design.

## Run AutoWorker offline

The local world runs the real engine, Jobs on kind, the bridge, the outbox, and Land against a fake GitHub, a fake Jira, and a Git daemon. The Codex stand-in plays the agent unless you pass `--agent real`. It needs no accounts, only the npm registry for `npm ci` inside the Jobs.

- One end-to-end run: `docker compose run --rm verify sh -c 'npm run verify -- kind up && npm run verify -- e2e --world local'`.
- One numbered lane: `p7-lane <n> --world local` in the same way. Lanes 11 to 19 run on the Codex stand-in, most through its rehearsals, so they need the local world.
- Seeded tasks for the dashboard: `local-engine --seed all` holds the engine, with Jobs on kind, over every seeded task, and prints its `DATABASE_URL`. It starts no dashboard. The dashboard lanes and `screens` start one with it through `withWorld` in `tools/verify/dashboard.ts`, as the Dashboard steps section of `AGENTS.md` describes.

## Hold AutoWorker against a real repository

`e2e-hold` runs the engine and the dashboard against one repository and one Jira search until you stop it. It is the closest thing to a deployment the repository has. [architecture.md](architecture.md) explains what runs inside it.

1. Pick the search. The hold's one routine runs it every minute, as the Jira account in `sandbox.env`, and takes each ticket it finds to a pull request merged into the base branch.
2. Start the hold from any worktree:

   ```bash
   docker compose run --rm -T -p 127.0.0.1:4860:4860 live node tools/verify/main.ts e2e-hold --repository <owner/name> --jql "project = <KEY> AND labels = <label> AND status != Done" --setup "npm ci" --fast-test "npm test"
   ```

   Run `node` as the container's command, not `npm run`, because `npm run` does not pass SIGTERM on. To use a GitHub token other than the one in `sandbox.env`, set `GITHUB_TOKEN` in the host shell and add `-e GITHUB_TOKEN` to the command.
3. Wait for the lines that print the dashboard's address, `JOB_NAMESPACE`, and `DATABASE_URL`, then open `http://127.0.0.1:4860`. Pick yourself under **Acting as** before you act on a task.
4. To stop the hold, type `stop` on its standard input, or run `docker stop -t 200 <container>` from the host. It stops the dashboard, gives the engine 150 s to finish its pass, deletes the attempt Jobs, stops Postgres, and keeps the database volume and the namespace. Never stop it by killing a process, because the teardown then never runs.

The hold keeps its state under the name `hold-<world>-<repository name>-<hash>`. The Docker volume of that name holds the database, and the namespace of that name holds the Jobs and the Secret `credential-key` that seals the logins. Run the same command again to restart with the kept state. Add `--fresh` to delete the volume and the namespace first.

Each start writes the setup again, and a few things follow from that:

- The repository's settings go back to the flags. `job_image` becomes empty, `verify_provider` becomes `tests-only`, the ignore lists become empty, and `draft_leaves` becomes `when-green`. Save any setting you changed on the Repositories page again after each restart.
- A routine you edited on the dashboard gets a new version that matches the flags again, unless you changed its goal or repository, in which case setup adds a second routine.
- A Codex login in `auth.json` replaces the stored one only when it expires later.

## Give a repository its own Job image

Each attempt runs in the attempt image, `services/job/Dockerfile`. When a repository's checks need a tool that image lacks, such as a browser for a smoke test, give the repository an image that extends it. `repository.job_image` accepts only a reference by digest, and the engine uses it for that repository's attempts in place of `JOB_IMAGE`.

1. Find the attempt image your engine runs. The hold and `local-engine` build it as `127.0.0.1:5001/autoworker-job:e2e`, so `docker image inspect 127.0.0.1:5001/autoworker-job:e2e --format '{{json .RepoDigests}}'` prints its digest.
2. Write a Dockerfile that starts from that image by digest, installs what the checks need as `root` from a pinned, checksummed download, removes every setuid and setgid bit it added, and returns to the bridge's user, `10001:10001`. This one adds Chrome:

   ```dockerfile
   # syntax=docker/dockerfile:1.7
   ARG ATTEMPT_IMAGE
   FROM ${ATTEMPT_IMAGE}
   USER root
   ADD --checksum=sha256:<sha256 of the package> https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_<version>-1_amd64.deb /tmp/google-chrome-stable.deb
   RUN apt-get update \
    && apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/google-chrome-stable.deb /etc/apt/sources.list.d/google-chrome.list \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
   USER 10001:10001
   ```

3. Build and push it to the local registry:

   ```bash
   docker build --build-arg ATTEMPT_IMAGE=127.0.0.1:5001/autoworker-job@sha256:<digest> -t 127.0.0.1:5001/<name>:<tag> .
   docker push 127.0.0.1:5001/<name>:<tag>
   docker image inspect 127.0.0.1:5001/<name>:<tag> --format '{{json .RepoDigests}}'
   ```

4. Save `127.0.0.1:5001/<name>@sha256:<digest>` as the repository's Job image on the Repositories page.

The image must extend the attempt image, because the Job's entry point, users, and bridge come from it. Build it again whenever the attempt image changes, since a Job from an older attempt image can speak an older bridge protocol, which the engine refuses with a reason that names the image. A registry other than the local one must serve the image publicly. Private registries belong to a fork.

## Diagnose a task that waits

Start from the task's page on the dashboard, `/tasks/<key>`. It shows the step, what the task waits on, the waiting reason, every attempt with its transcript, and Verify's evidence. The waiting reason is written for a person and says what to do.

| `task.waiting_on` | The task waits for | What a person does |
| --- | --- | --- |
| `answer` | An answer to the agent's question | Answers on the task page, then presses Approve, or sends back with a note |
| `approval` | A person's approval at a gate the routine set | Approves, or sends back with a note |
| `outside_approval` | An approval under the repository's rules | Approves the pull request on GitHub |
| `retry` | A person, because a cap was reached, a failure parked the task, a login failed, nobody can run the task, or an outside action failed | Fixes the cause the reason names, then presses Retry, with a note when the reason asks for one |

When the page does not explain it, read the record. From the host, `docker exec -it <hold name>-postgres psql -U test -d autoworker` opens the hold's database. These queries answer the common questions:

```sql
select id, state, step, waiting_on, waiting_reason, counts, epoch, owed_actions from task where key = '<key>';

select id, step, verdict, started_at, finished_at, obligation->>'kind' as owed, output->>'summary' as summary
from attempt where task_id = <task id> order by id;

select id, kind, state, tries, last_error from outbox where task_id = <task id> and state in ('owed', 'failed') order by position;

select at, kind, detail from human_action where task_id = <task id> order by at;

select body from attempt_event where attempt_id = <attempt id> and kind = 'end';
```

- **A task that is `ready` but does not move.** A task with an owed or failed outbox row is not ready, so check `owed_actions` and the outbox rows. An outside action that fails `OUTBOX_MAX_TRIES` times parks the task with its last error.
- **An attempt with no `finished_at`.** Its Job may still run. `docker exec autoworker-control-plane kubectl --kubeconfig /etc/kubernetes/admin.conf -n <namespace> get jobs,pods` lists the Jobs, and `logs` on a pod shows the bridge's lines. The reaper marks the attempt `lost` once its lease lapses.
- **An Implement that made no change.** `summary` is "The agent made no change." Read `owed` to see what the attempt was asked to fix, and the Job's end line, which names why a push was declined.
- **An `answer` wait that repeats.** A fourth question in a row counts as a failure.

The engine's log lines, which the hold prints with the prefix `engine:`, name each loop's actions, such as each Job it launches with its branch, start commit, and the person it runs as. [reference/engine.md](reference/engine.md#log-lines-that-tests-read) lists the lines that scenarios read.

`npm run verify -- local-engine-read --database <DATABASE_URL> --namespace <JOB_NAMESPACE> --logs` prints the same record with each Job's last log lines. Run it with `kind up` first, in a container of the same worktree as the hold, because the hold's Postgres listens only on that worktree's compose network.

## Measure rework on a live hold

To show that a change to rework holds up against real Codex, count how often Implement made no change, and how often it did so twice in a row with no person acting between. The census that proved the rework obligation counted 0 of those blind repeats in 84 reworks. [lessons.md](lessons.md) tells that story.

```sql
with implement as (
  select a.id, a.task_id, a.started_at, coalesce(a.obligation->>'kind', 'none (first implement)') as owed,
    a.output->>'summary' = 'The agent made no change.' as no_change
  from attempt a
  where a.step = 'implement' and a.id > :since
),
ordered as (
  select i.*, lag(i.no_change) over (partition by i.task_id order by i.id) as previous_no_change,
    lag(i.started_at) over (partition by i.task_id order by i.id) as previous_started
  from implement i
)
select o.owed, count(*) as implement_attempts, count(*) filter (where o.no_change) as no_change,
  count(*) filter (where o.no_change and o.previous_no_change and not exists (
    select 1 from human_action h where h.task_id = o.task_id and h.at between o.previous_started and o.started_at
  )) as blind_repeats
from ordered o
group by o.owed
order by o.owed;
```

Save it as a file and run it with `docker exec -i <hold name>-postgres psql -U test -d autoworker -v since=<last attempt id before the change> < census.sql`, so it counts only the attempts the change ran.

## Land a change

While the `ci` and `nightly` workflows are disabled on GitHub, the machine that integrates runs CI itself. See "CI runs locally while GitHub Actions is disabled" in [docs/decisions.md](../decisions.md#ci-runs-locally-while-github-actions-is-disabled).

1. Work on a branch in its own worktree, made from the latest `main`, for example with `git worktree add ../aw-<name> -b <type>/<name> origin/main`.
2. If the change grows a budgeted count, commit the raise alone first, with `npm run budget -- --raise <unit> --why "<why>"` and the file it writes in `budget/raises/`.
3. Commit the change. Cite the rules it follows in the message, as in `move parser into its feature folder (A4)`.
4. From the worktree's root on the host, run `node tools/budget/main.ts --since origin/main`. It fails when a commit that raises a ceiling also changes a file outside `budget/`.
5. Run `node tools/ci-local/main.ts` from the same root, with no uncommitted or untracked files. On 8 cores it took between 32 and 78 minutes in September 2026, depending on what else the machine ran. Integrate only when `ci-local/<sha>/summary.txt` says `PASS` for the head you push.
6. Push the branch, and open a pull request against `main`.
7. Merge with `gh pr merge <number> --merge --admin`. The ruleset on `main` requires the `check`, `models`, and `simulation` checks from GitHub Actions, which cannot report while `ci` is disabled, so an admin merge bypasses them. Merge only a head whose local CI passed.
8. Fold the raises. In a clean worktree on the new `main`, run `node tools/budget/main.ts --lower`, adding `--states ci-local/<sha>/<models log>` when local CI ran the models job on the landed commit. Commit the result alone, with the whys it prints, and land it the same way.

To turn CI on GitHub back on, run `gh workflow enable ci.yml` and `gh workflow enable nightly.yml`. The ruleset on `main` then gets its checks from Actions, and admin merges are no longer needed. Start the nightly workflow with `gh workflow run nightly.yml` before merging a batch and after changing a nightly config.

## Move to another machine

Everything in the repository moves with `git clone`. These things live only on the machine that made them, so recreate them:

- `~/.autoworker/sandbox.env` and `~/.autoworker/codex/auth.json`.
- `compose.override.yaml` in each worktree.
- The host's `node_modules`, from `npm ci --ignore-scripts`.
- Each worktree's `node_modules` volume and verify image, from the setup steps above.
- The kind cluster and the local registry with its images, which `kind up` and the scenarios make again. A repository's own Job image must be built, pushed, and saved again.
- A hold's database volume. A new hold starts with an empty database, and a search that ends in `AND status != Done` keeps it from redoing finished tickets. To keep an old hold's history, dump it with `pg_dump` from its Postgres container before you leave the machine.
- Local branches you never pushed, and `ci-local/` results, which Git ignores.

## Work on Windows

The repository runs on Windows with Docker Desktop and Git Bash or PowerShell.

- In Git Bash, set `MSYS_NO_PATHCONV=1` for a `docker` command that passes a container path, or Git Bash rewrites the path. Local CI sets it for its own steps.
- `.gitattributes` keeps code, SQL, TLA+, configs, and Dockerfiles at LF line endings. Markdown is not forced, and the parsers accept CR.
- Git inside the verify container cannot read a worktree made on Windows, because its `.git` file points at a Windows path. Run `--lower`, `--since`, and local CI on the host.
- Windows reuses process ids, which is one reason nothing in the tooling stops a process by its id.

## Fix common problems

- **"all predefined address pools have been fully subnetted".** Each compose project leaves a `<project>_default` network, and Docker's default address pools run out after about 30. Remove the networks no container uses with `docker network prune`, or give Docker larger address pools.
- **Containers left behind.** A killed local CI run leaves its step containers, and the next run in that worktree removes them. The next Postgres any scenario starts removes every Postgres whose verify container is gone. Never stop local CI by process. Use `node tools/ci-local/main.ts --stop` from its worktree.
- **A hold that refuses to start.** It names `<name>-postgres`, which means another hold with the same name still runs. Stop that hold first.
- **A model run that runs out of memory.** TLC takes the JVM's default heap on pull request configs and 75 percent of the container's memory on nightly configs. Give Docker more memory, or run fewer heavy checks at once.
- **A kind error that says to run kind down, then kind up.** The node runs another image than `kind.yaml` pins, or never became ready. Run `kind down` and `kind up` once no other lane uses the cluster.
- **A dashboard lane or hold that takes minutes to stop.** `next start` waits for every open request, and a live stream never ends, so the tools kill the dashboard 10 s after asking it to stop. Stop a hold with `docker stop -t 200`, which leaves enough time for the engine's 150 s.
- **`review-answers` fails at once.** It needs an existing `next build` of the dashboard. Run a dashboard lane or `screens` first.

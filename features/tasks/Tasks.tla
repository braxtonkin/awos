------------------------------- MODULE Tasks -------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tasks,
    Workers,
    NoTask,
    MaxRounds,
    MaxEnvReruns,
    MaxLost,
    MaxHumanActions,
    ClaimIsExclusive,
    ClaimNeedsReadyTask,
    LateResultIsRefused,
    RoundsAreCapped,
    EnvRerunsAreCapped,
    LostAttemptsAreCapped,
    BehaviorFailureReturnsToImplement,
    BehaviorFailureLeavesVerify,
    EnvironmentFailureStaysInVerify,
    FailureParksTask,
    RetryKeepsOutputs,
    RetryEndsAttempt,
    StopEndsAttempt,
    StopSparesDoneTasks,
    EndingSparesOtherTasks,
    ReaperIsFair

ASSUME NoTask \notin Tasks

ASSUME MaxRounds \in Nat \ {0} /\ MaxEnvReruns \in Nat /\ MaxLost \in Nat \ {0} /\ MaxHumanActions \in Nat

VARIABLES task, attempt, worker, lateResults, humanActions, claimEpoch

vars == <<task, attempt, worker, lateResults, humanActions, claimEpoch>>

Stages == {"specify", "implement", "verify", "land"}

Rank == [s \in Stages |->
    CASE s = "specify" -> 0
      [] s = "implement" -> 1
      [] s = "verify" -> 2
      [] s = "land" -> 3]

After == [s \in {"specify", "implement", "verify"} |->
    CASE s = "specify" -> "implement"
      [] s = "implement" -> "verify"
      [] s = "verify" -> "land"]

TaskStates == {"ready", "waiting", "stopped", "done"}

Settled == {"waiting", "stopped", "done"}

Outcomes(stage) ==
    IF stage = "verify"
    THEN {"pass", "behaviorFail", "environmentFail"}
    ELSE {"pass", "fail"}

Min(a, b) == IF a < b THEN a ELSE b

LiveOn(t) == {w \in Workers : attempt[w] = t}

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(f, S \ {x})

Spent == SumOver(humanActions, Tasks)

TypeOK ==
    /\ task \in [Tasks -> [stage : Stages,
                           state : TaskStates,
                           rounds : 0..(MaxRounds + 1),
                           reruns : 0..(MaxEnvReruns + 1),
                           lost : 0..(MaxLost + 1),
                           outputs : SUBSET Stages,
                           passed : BOOLEAN]]
    /\ attempt \in [Workers -> Tasks \cup {NoTask}]
    /\ worker \in [Workers -> {"idle", "busy", "hung"}]
    /\ lateResults \subseteq Tasks
    /\ humanActions \in [Tasks -> 0..MaxHumanActions]
    /\ claimEpoch \in [Workers -> 0..MaxHumanActions]

Init ==
    /\ task = [t \in Tasks |-> [stage |-> "specify", state |-> "ready", rounds |-> 0, reruns |-> 0, lost |-> 0, outputs |-> {}, passed |-> FALSE]]
    /\ attempt = [w \in Workers |-> NoTask]
    /\ worker = [w \in Workers |-> "idle"]
    /\ lateResults = {}
    /\ humanActions = [t \in Tasks |-> 0]
    /\ claimEpoch = [w \in Workers |-> 0]

Passed(current, s) ==
    IF s = "land"
    THEN [current EXCEPT !.state = "done", !.outputs = @ \cup {s}]
    ELSE [current EXCEPT !.stage = After[s],
                         !.outputs = @ \cup {s},
                         !.rounds = IF s = "verify" THEN 0 ELSE @,
                         !.reruns = 0]

Failed(current) == [current EXCEPT !.state = IF FailureParksTask THEN "waiting" ELSE "stopped"]

BehaviorFailed(current) ==
    IF RoundsAreCapped /\ current.rounds + 1 >= MaxRounds
    THEN [current EXCEPT !.state = "waiting", !.rounds = @ + 1]
    ELSE [current EXCEPT !.stage = CASE ~BehaviorFailureLeavesVerify -> "verify"
                                     [] BehaviorFailureReturnsToImplement -> "implement"
                                     [] OTHER -> "specify",
                         !.rounds = Min(@ + 1, MaxRounds + 1),
                         !.reruns = 0]

EnvironmentFailed(current) ==
    CASE ~EnvironmentFailureStaysInVerify -> Passed(current, current.stage)
      [] EnvRerunsAreCapped /\ current.reruns >= MaxEnvReruns -> [current EXCEPT !.state = "waiting"]
      [] OTHER -> [current EXCEPT !.reruns = Min(@ + 1, MaxEnvReruns + 1)]

Judged(current, v) ==
    CASE v = "pass" -> Passed(current, current.stage)
      [] v = "fail" -> Failed(current)
      [] v = "behaviorFail" -> BehaviorFailed(current)
      [] v = "environmentFail" -> EnvironmentFailed(current)

LostOnce(current) ==
    IF LostAttemptsAreCapped /\ current.lost + 1 >= MaxLost
    THEN [current EXCEPT !.state = "waiting", !.lost = @ + 1]
    ELSE [current EXCEPT !.lost = Min(@ + 1, MaxLost + 1)]

EndAttemptsOn(t) ==
    LET Ends(w) == IF EndingSparesOtherTasks THEN attempt[w] = t ELSE attempt[w] # NoTask
    IN /\ attempt' = [w \in Workers |-> IF Ends(w) THEN NoTask ELSE attempt[w]]
       /\ worker' = [w \in Workers |-> IF Ends(w) THEN "idle" ELSE worker[w]]
       /\ claimEpoch' = [w \in Workers |-> IF Ends(w) THEN 0 ELSE claimEpoch[w]]
       /\ lateResults' = IF LiveOn(t) = {} THEN lateResults ELSE lateResults \cup {t}

Claim(w, t) ==
    /\ worker[w] = "idle"
    /\ ClaimNeedsReadyTask => task[t].state = "ready"
    /\ ClaimIsExclusive => LiveOn(t) = {}
    /\ attempt' = [attempt EXCEPT ![w] = t]
    /\ worker' = [worker EXCEPT ![w] = "busy"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = humanActions[t]]
    /\ UNCHANGED <<task, lateResults, humanActions>>

Hang(w) ==
    /\ worker[w] = "busy"
    /\ worker' = [worker EXCEPT ![w] = "hung"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch>>

Wake(w) ==
    /\ worker[w] = "hung"
    /\ worker' = [worker EXCEPT ![w] = "busy"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch>>

Reap(w) ==
    /\ worker[w] = "hung"
    /\ task' = [task EXCEPT ![attempt[w]] = [LostOnce(@) EXCEPT !.passed = FALSE]]
    /\ lateResults' = lateResults \cup {attempt[w]}
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ UNCHANGED humanActions

Finish(w) ==
    /\ worker[w] = "busy"
    /\ \E v \in Outcomes(task[attempt[w]].stage) :
         task' = [task EXCEPT ![attempt[w]] = [Judged(@, v) EXCEPT !.lost = 0, !.passed = (v = "pass")]]
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ UNCHANGED <<lateResults, humanActions>>

LateResult(t) ==
    /\ t \in lateResults
    /\ lateResults' = lateResults \ {t}
    /\ IF LateResultIsRefused
       THEN UNCHANGED task
       ELSE \E v \in Outcomes(task[t].stage) : task' = [task EXCEPT ![t] = [Judged(@, v) EXCEPT !.passed = (v = "pass")]]
    /\ UNCHANGED <<attempt, worker, humanActions, claimEpoch>>

Stop(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in IF StopSparesDoneTasks THEN {"ready", "waiting"} ELSE {"ready", "waiting", "done"}
    /\ task' = [task EXCEPT ![t].state = "stopped", ![t].passed = FALSE]
    /\ IF StopEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]

Retry(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in {"ready", "waiting"}
    /\ task' = [task EXCEPT ![t].state = "ready",
                            ![t].rounds = 0,
                            ![t].reruns = 0,
                            ![t].lost = 0,
                            ![t].passed = FALSE,
                            ![t].outputs = IF RetryKeepsOutputs THEN @ ELSE {}]
    /\ IF RetryEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]

Terminated == \A t \in Tasks : task[t].state \in Settled

Next ==
    \/ \E w \in Workers, t \in Tasks : Claim(w, t)
    \/ \E w \in Workers : Hang(w) \/ Wake(w) \/ Reap(w) \/ Finish(w)
    \/ \E t \in Tasks : LateResult(t) \/ Stop(t) \/ Retry(t)
    \/ Terminated /\ UNCHANGED vars

WorkersProgress ==
    /\ \A t \in Tasks : WF_vars(\E w \in Workers : Claim(w, t))
    /\ \A w \in Workers : WF_vars(Finish(w))

ReaperProgress == \A w \in Workers : SF_vars(Reap(w))

Spec == Init /\ [][Next]_vars /\ WorkersProgress /\ (IF ReaperIsFair THEN ReaperProgress ELSE TRUE)

PersonActsOn(t) == humanActions'[t] = humanActions[t] + 1

AttemptEndsOn(t) == \E w \in Workers : attempt[w] = t /\ attempt'[w] # t

Advanced(t) == Rank[task'[t].stage] > Rank[task[t].stage] \/ (task'[t].state = "done" /\ task[t].state # "done")

OneLiveAttempt == \A t \in Tasks : Cardinality(LiveOn(t)) <= 1

LiveAttemptMeansReady == \A w \in Workers : attempt[w] # NoTask => task[attempt[w]].state = "ready"

LiveAttemptIsCurrent == \A w \in Workers : attempt[w] # NoTask => claimEpoch[w] = humanActions[attempt[w]]

OutputsSurvive == \A t \in Tasks : \A s \in Stages : Rank[s] < Rank[task[t].stage] => s \in task[t].outputs

RoundsCapped == \A t \in Tasks : task[t].rounds <= MaxRounds

EnvRerunsCapped == \A t \in Tasks : task[t].reruns <= MaxEnvReruns

LostAttemptsCapped == \A t \in Tasks : task[t].lost <= MaxLost

TaskChangesOnlyWithItsAttempt == [][\A t \in Tasks : task'[t] # task[t] => AttemptEndsOn(t) \/ PersonActsOn(t)]_vars

AttemptEndsOnlyWithItsTask == [][\A t \in Tasks : AttemptEndsOn(t) => task'[t] # task[t] \/ PersonActsOn(t)]_vars

FailedRoundReturnsToImplement == [][\A t \in Tasks : task'[t].rounds > task[t].rounds => task'[t].stage = "implement" \/ task'[t].state = "waiting"]_vars

LateWriteChangesNothing == [][lateResults' \subseteq lateResults /\ lateResults' # lateResults => UNCHANGED <<task, attempt, worker>>]_vars

OutputsOnlyGrow == [][\A t \in Tasks : task[t].outputs \subseteq task'[t].outputs]_vars

StageAdvancesOnlyOnPass == [][\A t \in Tasks : Advanced(t) => task'[t].passed]_vars

DoneIsFinal == [][\A t \in Tasks : task[t].state = "done" => task'[t] = task[t]]_vars

StageMovesOneStep ==
    [][\A t \in Tasks : task'[t].stage # task[t].stage =>
          \/ Rank[task'[t].stage] = Rank[task[t].stage] + 1
          \/ task[t].stage = "verify" /\ task'[t].stage = "implement"]_vars

OnlyAPersonStops == [][\A t \in Tasks : task'[t].state = "stopped" /\ task[t].state # "stopped" => PersonActsOn(t)]_vars

EveryTaskSettles == \A t \in Tasks : <>[](task[t].state \in Settled)

=============================================================================

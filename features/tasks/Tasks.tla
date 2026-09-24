------------------------------- MODULE Tasks -------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tasks,
    Workers,
    NoTask,
    EndStages,
    GateStages,
    Gated,
    IgnoreLaterReviews,
    ReadyBeforeGreen,
    MaxRounds,
    MaxEnvReruns,
    MaxLost,
    MaxStageRetries,
    MaxHumanActions,
    ClaimIsExclusive,
    ClaimNeedsReadyTask,
    LateResultIsRefused,
    RoundsAreCapped,
    EnvRerunsAreCapped,
    LostAttemptsAreCapped,
    StageRetriesAreCapped,
    PassResetsStageRetries,
    RetryResetsStageRetries,
    BehaviorFailureReturnsToImplement,
    BehaviorFailureLeavesVerify,
    EnvironmentFailureStaysInVerify,
    FailureParksTask,
    RetryKeepsOutputs,
    RetryEndsAttempt,
    StopEndsAttempt,
    StopSparesDoneTasks,
    EndingSparesOtherTasks,
    ReaperIsFair,
    EndStageIsFinal,
    GateBlocksUntilApproved,
    ReturnClearsApprovals,
    MergeChecksGates,
    MergeWaitsForMergeable,
    ReviewReturnIsCapped,
    RetryResumesStopped,
    RetryKeepsReviews,
    VerifyPassKeepsLandRounds,
    OutsideApprovalsAreFinite

ASSUME NoTask \notin Tasks

ASSUME MaxRounds \in Nat \ {0} /\ MaxEnvReruns \in Nat /\ MaxLost \in Nat \ {0} /\ MaxStageRetries \in Nat /\ MaxHumanActions \in Nat

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

Gates(t) == IF t \in Gated THEN GateStages ELSE {}

EndsFor(t) == {e \in EndStages : \A g \in Gates(t) : Rank[g] < Rank[e]}

ASSUME
    /\ EndStages \subseteq Stages
    /\ GateStages \subseteq DOMAIN After
    /\ Gated \cup IgnoreLaterReviews \cup ReadyBeforeGreen \subseteq Tasks
    /\ \A t \in Tasks : EndsFor(t) # {}

MaxReviewReturns == 1

Waiting == {"waiting", "gated", "awaitingApproval"}

TaskStates == {"ready", "stopped", "done"} \cup Waiting

Settled == {"stopped", "done"} \cup Waiting

Outcomes(stage) ==
    CASE stage = "verify" -> {"pass", "behaviorFail", "environmentFail"}
      [] stage = "land" -> {"pass", "fail", "red", "changesRequested", "reviewRequired"}
      [] OTHER -> {"pass", "fail"}

Min(a, b) == IF a < b THEN a ELSE b

LiveOn(t) == {w \in Workers : attempt[w] = t}

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(f, S \ {x})

Spent == SumOver(humanActions, Tasks)

TypeOK ==
    /\ task \in [Tasks -> [stage : Stages,
                           state : TaskStates,
                           end : Stages,
                           approved : SUBSET DOMAIN After,
                           reviews : 0..(MaxReviewReturns + 1),
                           rounds : 0..(MaxRounds + 1),
                           landRounds : 0..(MaxRounds + 1),
                           reruns : 0..(MaxEnvReruns + 1),
                           lost : 0..(MaxLost + 1),
                           retries : 0..(MaxStageRetries + 1),
                           outputs : SUBSET Stages,
                           passed : BOOLEAN]]
    /\ attempt \in [Workers -> Tasks \cup {NoTask}]
    /\ worker \in [Workers -> {"idle", "busy", "hung"}]
    /\ lateResults \subseteq Tasks
    /\ humanActions \in [Tasks -> 0..MaxHumanActions]
    /\ claimEpoch \in [Workers -> 0..MaxHumanActions]

Init ==
    /\ \E ends \in [Tasks -> EndStages] :
         /\ \A t \in Tasks : ends[t] \in EndsFor(t)
         /\ task = [t \in Tasks |-> [stage |-> "specify", state |-> "ready", end |-> ends[t], approved |-> {}, reviews |-> 0, rounds |-> 0, landRounds |-> 0, reruns |-> 0, lost |-> 0, retries |-> 0, outputs |-> {}, passed |-> FALSE]]
    /\ attempt = [w \in Workers |-> NoTask]
    /\ worker = [w \in Workers |-> "idle"]
    /\ lateResults = {}
    /\ humanActions = [t \in Tasks |-> 0]
    /\ claimEpoch = [w \in Workers |-> 0]

Passed(t, current, s) ==
    LET kept == [current EXCEPT !.outputs = @ \cup {s},
                                !.rounds = IF s = "verify" THEN 0 ELSE @,
                                !.landRounds = IF s = "verify" /\ ~VerifyPassKeepsLandRounds THEN 0 ELSE @,
                                !.reruns = 0,
                                !.retries = IF PassResetsStageRetries THEN 0 ELSE @]
    IN IF s = "land" \/ (EndStageIsFinal /\ s = current.end) THEN [kept EXCEPT !.state = "done"]
       ELSE IF GateBlocksUntilApproved /\ s \in Gates(t) \ current.approved THEN [kept EXCEPT !.state = "gated"]
       ELSE [kept EXCEPT !.stage = After[s]]

Failed(current) ==
    IF StageRetriesAreCapped /\ current.retries >= MaxStageRetries
    THEN [current EXCEPT !.state = IF FailureParksTask THEN "waiting" ELSE "stopped"]
    ELSE [current EXCEPT !.retries = Min(@ + 1, MaxStageRetries + 1)]

SentBack(current, s) ==
    [current EXCEPT !.stage = s,
                    !.approved = IF ReturnClearsApprovals THEN {g \in @ : Rank[g] < Rank[s]} ELSE @,
                    !.reruns = 0,
                    !.retries = 0]

BehaviorFailed(current) ==
    IF RoundsAreCapped /\ current.rounds + 1 >= MaxRounds
    THEN [current EXCEPT !.state = "waiting", !.rounds = @ + 1]
    ELSE [SentBack(current, CASE ~BehaviorFailureLeavesVerify -> "verify"
                              [] BehaviorFailureReturnsToImplement -> "implement"
                              [] OTHER -> "specify") EXCEPT !.rounds = Min(@ + 1, MaxRounds + 1)]

EnvironmentFailed(t, current) ==
    CASE ~EnvironmentFailureStaysInVerify -> Passed(t, current, current.stage)
      [] EnvRerunsAreCapped /\ current.reruns >= MaxEnvReruns -> [current EXCEPT !.state = "waiting"]
      [] OTHER -> [current EXCEPT !.reruns = Min(@ + 1, MaxEnvReruns + 1)]

SentBackFromLand(current) ==
    IF RoundsAreCapped /\ current.landRounds + 1 >= MaxRounds
    THEN [current EXCEPT !.state = "waiting", !.landRounds = @ + 1]
    ELSE [SentBack(current, "implement") EXCEPT !.landRounds = Min(@ + 1, MaxRounds + 1)]

ReviewReturned(current) ==
    [SentBack(current, "implement") EXCEPT !.reviews = Min(@ + 1, MaxReviewReturns + 1), !.landRounds = 0]

AwaitingApproval(current) == [current EXCEPT !.state = "awaitingApproval"]

Merged(t, current) ==
    IF MergeChecksGates /\ ~(Gates(t) \subseteq current.approved)
    THEN [current EXCEPT !.state = "waiting"]
    ELSE Passed(t, current, "land")

RedChecked(t, current) ==
    IF t \notin ReadyBeforeGreen THEN SentBackFromLand(current)
    ELSE IF MergeWaitsForMergeable THEN Failed(current)
    ELSE Merged(t, current)

ChangesRequested(t, current) ==
    IF current.reviews < MaxReviewReturns \/ ~ReviewReturnIsCapped THEN ReviewReturned(current)
    ELSE IF t \notin IgnoreLaterReviews THEN [current EXCEPT !.state = "waiting"]
    ELSE IF MergeWaitsForMergeable THEN AwaitingApproval(current)
    ELSE Merged(t, current)

Judged(t, current, v) ==
    CASE v = "pass" -> IF current.stage = "land" THEN Merged(t, current) ELSE Passed(t, current, current.stage)
      [] v = "fail" -> Failed(current)
      [] v = "behaviorFail" -> BehaviorFailed(current)
      [] v = "environmentFail" -> EnvironmentFailed(t, current)
      [] v = "red" -> RedChecked(t, current)
      [] v = "changesRequested" -> ChangesRequested(t, current)
      [] v = "reviewRequired" -> AwaitingApproval(current)

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
         task' = [task EXCEPT ![attempt[w]] = [Judged(attempt[w], @, v) EXCEPT !.lost = 0, !.passed = (v = "pass")]]
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ UNCHANGED <<lateResults, humanActions>>

LateResult(t) ==
    /\ t \in lateResults
    /\ lateResults' = lateResults \ {t}
    /\ IF LateResultIsRefused
       THEN UNCHANGED task
       ELSE \E v \in Outcomes(task[t].stage) : task' = [task EXCEPT ![t] = [Judged(t, @, v) EXCEPT !.passed = (v = "pass")]]
    /\ UNCHANGED <<attempt, worker, humanActions, claimEpoch>>

Stop(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in IF StopSparesDoneTasks THEN {"ready"} \cup Waiting ELSE {"ready", "done"} \cup Waiting
    /\ task' = [task EXCEPT ![t].state = "stopped", ![t].passed = FALSE]
    /\ IF StopEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]

Retry(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in IF RetryResumesStopped THEN {"ready", "stopped"} \cup Waiting ELSE {"ready"} \cup Waiting
    /\ task' = [task EXCEPT ![t].state = "ready",
                            ![t].rounds = 0,
                            ![t].landRounds = 0,
                            ![t].reruns = 0,
                            ![t].lost = 0,
                            ![t].retries = IF RetryResetsStageRetries THEN 0 ELSE @,
                            ![t].reviews = IF RetryKeepsReviews THEN @ ELSE 0,
                            ![t].passed = FALSE,
                            ![t].outputs = IF RetryKeepsOutputs THEN @ ELSE {}]
    /\ IF RetryEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]

Approve(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state = "gated"
    /\ task' = [task EXCEPT ![t].stage = After[task[t].stage],
                            ![t].state = "ready",
                            ![t].approved = @ \cup {task[t].stage}]
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<attempt, worker, lateResults, claimEpoch>>

OutsideApproval(t) ==
    /\ task[t].state = "awaitingApproval"
    /\ task' = [task EXCEPT ![t].state = "ready"]
    /\ UNCHANGED <<attempt, worker, lateResults, humanActions, claimEpoch>>

Terminated == \A t \in Tasks : task[t].state \in Settled

Next ==
    \/ \E w \in Workers, t \in Tasks : Claim(w, t)
    \/ \E w \in Workers : Hang(w) \/ Wake(w) \/ Reap(w) \/ Finish(w)
    \/ \E t \in Tasks : LateResult(t) \/ Stop(t) \/ Retry(t) \/ Approve(t) \/ OutsideApproval(t)
    \/ Terminated /\ UNCHANGED vars

WorkersProgress ==
    /\ \A t \in Tasks : WF_vars(\E w \in Workers : Claim(w, t))
    /\ \A w \in Workers : WF_vars(Finish(w))

ReaperProgress == \A w \in Workers : SF_vars(Reap(w))

OutsideApprovalsStop == <>[][\A t \in Tasks : ~OutsideApproval(t)]_vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WorkersProgress
    /\ IF OutsideApprovalsAreFinite THEN OutsideApprovalsStop ELSE TRUE
    /\ IF ReaperIsFair THEN ReaperProgress ELSE TRUE

PersonActsOn(t) == humanActions'[t] = humanActions[t] + 1

OutsideApproves(t) == task[t].state = "awaitingApproval" /\ task'[t].state = "ready" /\ humanActions' = humanActions

AttemptEndsOn(t) == \E w \in Workers : attempt[w] = t /\ attempt'[w] # t

Advanced(t) == Rank[task'[t].stage] > Rank[task[t].stage] \/ (task'[t].state = "done" /\ task[t].state # "done")

OneLiveAttempt == \A t \in Tasks : Cardinality(LiveOn(t)) <= 1

LiveAttemptMeansReady == \A w \in Workers : attempt[w] # NoTask => task[attempt[w]].state = "ready"

LiveAttemptIsCurrent == \A w \in Workers : attempt[w] # NoTask => claimEpoch[w] = humanActions[attempt[w]]

OutputsSurvive == \A t \in Tasks : \A s \in Stages : Rank[s] < Rank[task[t].stage] => s \in task[t].outputs

RoundsCapped == \A t \in Tasks : task[t].rounds <= MaxRounds /\ task[t].landRounds <= MaxRounds

EnvRerunsCapped == \A t \in Tasks : task[t].reruns <= MaxEnvReruns

LostAttemptsCapped == \A t \in Tasks : task[t].lost <= MaxLost

StageRetriesCapped == \A t \in Tasks : task[t].retries <= MaxStageRetries

PassLeavesNoStageRetries == \A t \in Tasks : task[t].passed => task[t].retries = 0

StopsAtItsEndStage == \A t \in Tasks : Rank[task[t].stage] <= Rank[task[t].end] /\ (task[t].state = "done" => task[t].stage = task[t].end)

ApprovalsMatchGatesPassed == \A t \in Tasks : task[t].approved = {g \in Gates(t) : Rank[g] < Rank[task[t].stage]}

ReviewReturnsCapped == \A t \in Tasks : task[t].reviews <= MaxReviewReturns

StoppedTaskCanResume ==
    \A t \in Tasks : task[t].state = "stopped" /\ Spent < MaxHumanActions =>
        ENABLED (Retry(t) /\ task'[t].state = "ready"
                          /\ task'[t].stage = task[t].stage
                          /\ task'[t].outputs = task[t].outputs
                          /\ task'[t].approved = task[t].approved
                          /\ task'[t].reviews = task[t].reviews)

TaskChangesOnlyWithItsAttempt == [][\A t \in Tasks : task'[t] # task[t] => AttemptEndsOn(t) \/ PersonActsOn(t) \/ OutsideApproves(t)]_vars

AttemptEndsOnlyWithItsTask == [][\A t \in Tasks : AttemptEndsOn(t) => task'[t] # task[t] \/ PersonActsOn(t)]_vars

FailedRoundReturnsToImplement ==
    [][\A t \in Tasks : task'[t].rounds > task[t].rounds \/ task'[t].landRounds > task[t].landRounds =>
          task'[t].stage = "implement" \/ task'[t].state = "waiting"]_vars

LateWriteChangesNothing == [][lateResults' \subseteq lateResults /\ lateResults' # lateResults => UNCHANGED <<task, attempt, worker>>]_vars

OutputsOnlyGrow == [][\A t \in Tasks : task[t].outputs \subseteq task'[t].outputs]_vars

StageAdvancesOnlyOnPass == [][\A t \in Tasks : Advanced(t) => task'[t].passed]_vars

DoneIsFinal == [][\A t \in Tasks : task[t].state = "done" => task'[t] = task[t]]_vars

StageMovesOneStep ==
    [][\A t \in Tasks : task'[t].stage # task[t].stage =>
          \/ Rank[task'[t].stage] = Rank[task[t].stage] + 1
          \/ task[t].stage \in {"verify", "land"} /\ task'[t].stage = "implement"]_vars

OnlyAPersonStops == [][\A t \in Tasks : task'[t].state = "stopped" /\ task[t].state # "stopped" => PersonActsOn(t)]_vars

RetryLeavesNoStageRetries == [][\A t \in Tasks : PersonActsOn(t) /\ task'[t].state = "ready" => task'[t].retries = 0]_vars

GatePassesOnlyOnApprove ==
    [][\A t \in Tasks : \A g \in Gates(t) :
          Rank[task[t].stage] <= Rank[g] /\ Rank[task'[t].stage] > Rank[g] => PersonActsOn(t) /\ g \in task'[t].approved]_vars

MergeNeedsEveryGate ==
    [][\A t \in Tasks : task[t].stage = "land" /\ task[t].state # "done" /\ task'[t].state = "done" =>
          task'[t].passed /\ Gates(t) \subseteq task[t].approved]_vars

EveryTaskSettles == \A t \in Tasks : <>[](task[t].state \in Settled)

=============================================================================

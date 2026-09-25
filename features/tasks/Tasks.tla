------------------------------- MODULE Tasks -------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Tasks,
    Workers,
    NoTask,
    Steps,
    ReturnsTo,
    Checks,
    Merges,
    Asking,
    EndSteps,
    GateSteps,
    Gated,
    IgnoreLaterReviews,
    ReadyBeforeGreen,
    Reassignable,
    MaxRounds,
    MaxEnvReruns,
    MaxLost,
    MaxStageRetries,
    MaxInputWaits,
    MaxHumanActions,
    MaxReassignments,
    MaxLaunchFaults,
    ClaimIsExclusive,
    ClaimNeedsReadyTask,
    ClaimNeedsAPerson,
    NoOneParksTask,
    LateResultIsRefused,
    RoundsAreCapped,
    EnvRerunsAreCapped,
    LostAttemptsAreCapped,
    StageRetriesAreCapped,
    InputWaitsAreCapped,
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
    OutsideApprovalsAreFinite,
    LaterReviewParks,
    OutsideApprovalNeedsAWait,
    RetryKeepsApprovals,
    LostApprovalStaysLost,
    LapsedLeaseCannotRenew,
    RefusedLaunchIsNotLost,
    FailedLaunchRelaunches,
    RetryWaitsAtGate

CodeChangeSteps == <<"specify", "implement", "verify", "land">>

StepSet == {Steps[i] : i \in DOMAIN Steps}

Rank == [s \in StepSet |-> CHOOSE i \in DOMAIN Steps : Steps[i] = s]

First == Steps[1]

Last == Steps[Len(Steps)]

After == [s \in StepSet \ {Last} |-> Steps[Rank[s] + 1]]

Returning == Checks \cup Merges

Gates(t) == IF t \in Gated THEN GateSteps ELSE {}

EndsFor(t) == {e \in EndSteps : \A g \in Gates(t) : Rank[g] < Rank[e]}

ASSUME NoTask \notin Tasks

ASSUME
    /\ Steps \in Seq(STRING)
    /\ Len(Steps) > 0
    /\ Cardinality(StepSet) = Len(Steps)
    /\ Returning \cup Asking \cup EndSteps \subseteq StepSet
    /\ Checks \cap Merges = {}
    /\ ReturnsTo \in StepSet
    /\ \A r \in Returning : Rank[ReturnsTo] < Rank[r]
    /\ GateSteps \subseteq DOMAIN After
    /\ Gated \cup IgnoreLaterReviews \cup ReadyBeforeGreen \cup Reassignable \subseteq Tasks
    /\ \A t \in Tasks : EndsFor(t) # {}

ASSUME
    /\ MaxRounds \in Nat \ {0}
    /\ MaxEnvReruns \in Nat
    /\ MaxLost \in Nat \ {0}
    /\ MaxStageRetries \in Nat
    /\ MaxInputWaits \in Nat
    /\ MaxHumanActions \in Nat
    /\ MaxReassignments \in Nat
    /\ MaxLaunchFaults \in Nat

VARIABLES task, attempt, worker, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults

vars == <<task, attempt, worker, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Live == {"busy", "failed"}

MaxReviewReturns == 1

Waiting == {"waiting", "gated", "asking", "awaitingApproval"}

TaskStates == {"ready", "stopped", "done"} \cup Waiting

Settled == {"stopped", "done"} \cup Waiting

NoRounds == [r \in Returning |-> 0]

Outcomes(s) ==
    {"pass"}
      \cup (IF s \in Checks THEN {"behaviorFail", "environmentFail"} ELSE {"fail"})
      \cup (IF s \in Asking THEN {"needsInput"} ELSE {})
      \cup (IF s \in Merges THEN {"red", "changesRequested", "reviewRequired"} ELSE {})

Min(a, b) == IF a < b THEN a ELSE b

LiveOn(t) == {w \in Workers : attempt[w] = t}

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(f, S \ {x})

Spent == SumOver(humanActions, Tasks)

TypeOK ==
    /\ task \in [Tasks -> [step : StepSet,
                           state : TaskStates,
                           end : StepSet,
                           approved : SUBSET DOMAIN After,
                           missing : SUBSET DOMAIN After,
                           reviews : 0..(MaxReviewReturns + 1),
                           rounds : [Returning -> 0..(MaxRounds + 1)],
                           reruns : 0..(MaxEnvReruns + 1),
                           lost : 0..(MaxLost + 1),
                           retries : 0..(MaxStageRetries + 1),
                           inputWaits : 0..(MaxInputWaits + 1),
                           outputs : SUBSET StepSet,
                           passed : BOOLEAN]]
    /\ attempt \in [Workers -> Tasks \cup {NoTask}]
    /\ worker \in [Workers -> {"idle", "hung"} \cup Live]
    /\ lateResults \subseteq Tasks
    /\ humanActions \in [Tasks -> 0..MaxHumanActions]
    /\ claimEpoch \in [Workers -> 0..MaxHumanActions]
    /\ runnable \in [Tasks -> BOOLEAN]
    /\ runAs \in [Workers -> BOOLEAN]
    /\ reassignments \in 0..MaxReassignments
    /\ launchFaults \in 0..MaxLaunchFaults

Init ==
    /\ \E ends \in [Tasks -> EndSteps] :
         /\ \A t \in Tasks : ends[t] \in EndsFor(t)
         /\ task = [t \in Tasks |-> [step |-> First, state |-> "ready", end |-> ends[t], approved |-> {}, missing |-> {}, reviews |-> 0, rounds |-> NoRounds, reruns |-> 0, lost |-> 0, retries |-> 0, inputWaits |-> 0, outputs |-> {}, passed |-> FALSE]]
    /\ attempt = [w \in Workers |-> NoTask]
    /\ worker = [w \in Workers |-> "idle"]
    /\ lateResults = {}
    /\ humanActions = [t \in Tasks |-> 0]
    /\ claimEpoch = [w \in Workers |-> 0]
    /\ runnable = [t \in Tasks |-> TRUE]
    /\ runAs = [w \in Workers |-> FALSE]
    /\ reassignments = 0
    /\ launchFaults = 0

Passed(t, current, s) ==
    LET kept == [current EXCEPT !.outputs = @ \cup {s},
                                !.rounds = [r \in Returning |-> IF r = s \/ (s \in Checks /\ ~VerifyPassKeepsLandRounds) THEN 0 ELSE @[r]],
                                !.reruns = 0,
                                !.inputWaits = 0,
                                !.retries = IF PassResetsStageRetries THEN 0 ELSE @]
    IN IF s = Last \/ (EndStageIsFinal /\ s = current.end) THEN [kept EXCEPT !.state = "done"]
       ELSE IF GateBlocksUntilApproved /\ s \in Gates(t) \ current.approved THEN [kept EXCEPT !.state = "gated"]
       ELSE [kept EXCEPT !.step = After[s]]

Failed(current) ==
    IF StageRetriesAreCapped /\ current.retries >= MaxStageRetries
    THEN [current EXCEPT !.state = IF FailureParksTask THEN "waiting" ELSE "stopped"]
    ELSE [current EXCEPT !.retries = Min(@ + 1, MaxStageRetries + 1)]

NeedsInput(current) ==
    IF InputWaitsAreCapped /\ current.inputWaits >= MaxInputWaits
    THEN Failed(current)
    ELSE [current EXCEPT !.state = "asking", !.inputWaits = Min(@ + 1, MaxInputWaits + 1)]

SentBack(current, s) ==
    LET held == IF LostApprovalStaysLost THEN current.approved ELSE current.approved \cup current.missing
    IN [current EXCEPT !.step = s,
                       !.approved = IF ReturnClearsApprovals THEN {g \in held : Rank[g] < Rank[s]} ELSE held,
                       !.missing = {g \in @ : Rank[g] < Rank[s]},
                       !.reruns = 0,
                       !.retries = 0,
                       !.inputWaits = 0]

RoundFailed(current, target) ==
    LET s == current.step
    IN IF RoundsAreCapped /\ current.rounds[s] + 1 >= MaxRounds
       THEN [current EXCEPT !.state = "waiting", !.rounds[s] = @ + 1]
       ELSE [SentBack(current, target) EXCEPT !.rounds[s] = Min(@ + 1, MaxRounds + 1)]

BehaviorFailed(current) ==
    RoundFailed(current, CASE ~BehaviorFailureLeavesVerify -> current.step
                           [] BehaviorFailureReturnsToImplement -> ReturnsTo
                           [] OTHER -> First)

EnvironmentFailed(t, current) ==
    CASE ~EnvironmentFailureStaysInVerify -> Passed(t, current, current.step)
      [] EnvRerunsAreCapped /\ current.reruns >= MaxEnvReruns -> [current EXCEPT !.state = "waiting"]
      [] OTHER -> [current EXCEPT !.reruns = Min(@ + 1, MaxEnvReruns + 1)]

ReviewReturned(current) ==
    [SentBack(current, ReturnsTo) EXCEPT !.reviews = Min(@ + 1, MaxReviewReturns + 1), !.rounds[current.step] = 0]

AwaitingApproval(current) == [current EXCEPT !.state = "awaitingApproval"]

Merged(t, current) ==
    IF MergeChecksGates /\ ~(Gates(t) \subseteq current.approved)
    THEN [current EXCEPT !.state = "waiting", !.retries = 0]
    ELSE Passed(t, current, current.step)

RedChecked(t, current) ==
    IF t \notin ReadyBeforeGreen THEN RoundFailed(current, ReturnsTo)
    ELSE IF MergeWaitsForMergeable THEN Failed(current)
    ELSE Merged(t, current)

ChangesRequested(t, current) ==
    IF current.reviews < MaxReviewReturns \/ ~ReviewReturnIsCapped THEN ReviewReturned(current)
    ELSE IF t \notin IgnoreLaterReviews /\ LaterReviewParks THEN [current EXCEPT !.state = "waiting"]
    ELSE IF MergeWaitsForMergeable THEN AwaitingApproval(current)
    ELSE Merged(t, current)

Judged(t, current, v) ==
    CASE v = "pass" -> IF current.step \in Merges THEN Merged(t, current) ELSE Passed(t, current, current.step)
      [] v = "fail" -> Failed(current)
      [] v = "needsInput" -> NeedsInput(current)
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
       /\ runAs' = [w \in Workers |-> IF Ends(w) THEN FALSE ELSE runAs[w]]
       /\ lateResults' = IF LiveOn(t) = {} THEN lateResults ELSE lateResults \cup {t}

Claim(w, t) ==
    /\ worker[w] = "idle"
    /\ ClaimNeedsReadyTask => task[t].state = "ready"
    /\ ClaimIsExclusive => LiveOn(t) = {}
    /\ ClaimNeedsAPerson => runnable[t]
    /\ attempt' = [attempt EXCEPT ![w] = t]
    /\ worker' = [worker EXCEPT ![w] = "busy"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = humanActions[t]]
    /\ runAs' = [runAs EXCEPT ![w] = runnable[t]]
    /\ UNCHANGED <<task, lateResults, humanActions, runnable, reassignments, launchFaults>>

NoOneToRunAs(t) ==
    /\ task[t].state = "ready"
    /\ LiveOn(t) = {}
    /\ ~runnable[t]
    /\ task' = IF NoOneParksTask THEN [task EXCEPT ![t].state = "waiting"] ELSE task
    /\ UNCHANGED <<attempt, worker, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Reassign(t) ==
    /\ reassignments < MaxReassignments
    /\ t \in Reassignable
    /\ task[t].step = First
    /\ task[t].state = "ready"
    /\ runnable' = [runnable EXCEPT ![t] = ~@]
    /\ reassignments' = reassignments + 1
    /\ UNCHANGED <<task, attempt, worker, lateResults, humanActions, claimEpoch, runAs, launchFaults>>

Launch(w) ==
    /\ FailedLaunchRelaunches
    /\ worker[w] = "failed"
    /\ worker' = [worker EXCEPT ![w] = "busy"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

LaunchFails(w) ==
    /\ worker[w] = "busy"
    /\ launchFaults < MaxLaunchFaults
    /\ launchFaults' = launchFaults + 1
    /\ worker' = [worker EXCEPT ![w] = "failed"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments>>

Refuse(w) ==
    /\ worker[w] \in Live
    /\ task' = [task EXCEPT ![attempt[w]] = [IF RefusedLaunchIsNotLost THEN @ ELSE LostOnce(@) EXCEPT !.state = "waiting", !.passed = FALSE]]
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ runAs' = [runAs EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<lateResults, humanActions, runnable, reassignments, launchFaults>>

Hang(w) ==
    /\ worker[w] \in Live
    /\ worker' = [worker EXCEPT ![w] = "hung"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Wake(w) ==
    /\ ~LapsedLeaseCannotRenew
    /\ worker[w] = "hung"
    /\ worker' = [worker EXCEPT ![w] = "busy"]
    /\ UNCHANGED <<task, attempt, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Reap(w) ==
    /\ worker[w] = "hung"
    /\ task' = [task EXCEPT ![attempt[w]] = [LostOnce(@) EXCEPT !.passed = FALSE]]
    /\ lateResults' = lateResults \cup {attempt[w]}
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ runAs' = [runAs EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<humanActions, runnable, reassignments, launchFaults>>

Finishes(w, v) ==
    /\ worker[w] = "busy"
    /\ task' = [task EXCEPT ![attempt[w]] = [Judged(attempt[w], @, v) EXCEPT !.lost = 0, !.passed = (v = "pass")]]
    /\ attempt' = [attempt EXCEPT ![w] = NoTask]
    /\ worker' = [worker EXCEPT ![w] = "idle"]
    /\ claimEpoch' = [claimEpoch EXCEPT ![w] = 0]
    /\ runAs' = [runAs EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<lateResults, humanActions, runnable, reassignments, launchFaults>>

Finish(w) == worker[w] = "busy" /\ \E v \in Outcomes(task[attempt[w]].step) : Finishes(w, v)

LateResult(t) ==
    /\ t \in lateResults
    /\ lateResults' = lateResults \ {t}
    /\ IF LateResultIsRefused
       THEN UNCHANGED task
       ELSE \E v \in Outcomes(task[t].step) : task' = [task EXCEPT ![t] = [Judged(t, @, v) EXCEPT !.passed = (v = "pass")]]
    /\ UNCHANGED <<attempt, worker, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Stop(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in IF StopSparesDoneTasks THEN {"ready"} \cup Waiting ELSE {"ready", "done"} \cup Waiting
    /\ task' = [task EXCEPT ![t].state = "stopped", ![t].passed = @ /\ task[t].state = "gated"]
    /\ IF StopEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch, runAs, launchFaults>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<runnable, reassignments, launchFaults>>

RetriesFrom == IF RetryResumesStopped THEN {"ready", "stopped"} \cup Waiting ELSE {"ready"} \cup Waiting

Retried(current) ==
    [current EXCEPT !.state = "ready",
                    !.rounds = NoRounds,
                    !.reruns = 0,
                    !.lost = 0,
                    !.inputWaits = 0,
                    !.retries = IF RetryResetsStageRetries THEN 0 ELSE @,
                    !.reviews = IF RetryKeepsReviews THEN @ ELSE 0,
                    !.approved = IF RetryKeepsApprovals THEN @ ELSE {},
                    !.passed = FALSE,
                    !.outputs = IF RetryKeepsOutputs THEN @ ELSE {}]

StoppedAtGate(current) == current.state = "stopped" /\ current.passed

Resumed(current) ==
    IF RetryWaitsAtGate /\ StoppedAtGate(current)
    THEN [current EXCEPT !.state = "gated", !.lost = 0]
    ELSE Retried(current)

Retry(t) ==
    /\ Spent < MaxHumanActions
    /\ task[t].state \in RetriesFrom
    /\ task' = [task EXCEPT ![t] = Resumed(@)]
    /\ IF RetryEndsAttempt THEN EndAttemptsOn(t) ELSE UNCHANGED <<attempt, worker, lateResults, claimEpoch, runAs, launchFaults>>
    /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<runnable, reassignments, launchFaults>>

Approve(t) ==
    LET current == task[t]
    IN /\ Spent < MaxHumanActions
       /\ current.state \in {"gated", "asking"}
       /\ task' = [task EXCEPT ![t] = IF current.state = "gated"
                                       THEN [current EXCEPT !.step = After[current.step], !.state = "ready", !.approved = current.approved \cup {current.step}]
                                       ELSE [current EXCEPT !.state = "ready", !.retries = 0]]
       /\ humanActions' = [humanActions EXCEPT ![t] = @ + 1]
       /\ UNCHANGED <<attempt, worker, lateResults, claimEpoch, runnable, runAs, reassignments, launchFaults>>

OutsideApproval(t) ==
    /\ OutsideApprovalNeedsAWait => task[t].state = "awaitingApproval"
    /\ task' = [task EXCEPT ![t].state = "ready"]
    /\ UNCHANGED <<attempt, worker, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

ApprovalGoesMissing(t) == task[t].step \in Merges /\ task'[t] = [task[t] EXCEPT !.approved = {}, !.missing = @ \cup task[t].approved]

LoseApproval(t) ==
    /\ task[t].state = "ready"
    /\ task[t].step \in Merges
    /\ task[t].approved # {}
    /\ LiveOn(t) = {}
    /\ task' = [task EXCEPT ![t].approved = {}, ![t].missing = @ \cup task[t].approved]
    /\ UNCHANGED <<attempt, worker, lateResults, humanActions, claimEpoch, runnable, runAs, reassignments, launchFaults>>

Terminated == \A t \in Tasks : task[t].state \in Settled

Next ==
    \/ \E w \in Workers, t \in Tasks : Claim(w, t)
    \/ \E w \in Workers : Launch(w) \/ LaunchFails(w) \/ Refuse(w) \/ Hang(w) \/ Wake(w) \/ Reap(w) \/ Finish(w)
    \/ \E t \in Tasks : LateResult(t) \/ Stop(t) \/ Retry(t) \/ Approve(t) \/ OutsideApproval(t) \/ LoseApproval(t) \/ NoOneToRunAs(t) \/ Reassign(t)
    \/ Terminated /\ UNCHANGED vars

WorkersProgress ==
    /\ \A t \in Tasks : WF_vars(\E w \in Workers : Claim(w, t))
    /\ \A t \in Tasks : WF_vars(NoOneToRunAs(t))
    /\ \A w \in Workers : WF_vars(Launch(w))
    /\ \A w \in Workers : WF_vars(Finish(w))

ReaperProgress == \A w \in Workers : WF_vars(Reap(w))

OutsideApprovalsStop == <>[][\A t \in Tasks : ~OutsideApproval(t)]_vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WorkersProgress
    /\ IF OutsideApprovalsAreFinite THEN OutsideApprovalsStop ELSE TRUE
    /\ IF ReaperIsFair THEN ReaperProgress ELSE TRUE

PersonActsOn(t) == humanActions'[t] = humanActions[t] + 1

OutsideApproves(t) == task[t].state = "awaitingApproval" /\ task'[t] = [task[t] EXCEPT !.state = "ready"] /\ humanActions' = humanActions

FoundNoOne(t) == task[t].state = "ready" /\ LiveOn(t) = {} /\ ~runnable[t] /\ task'[t] = [task[t] EXCEPT !.state = "waiting"]

AttemptEndsOn(t) == \E w \in Workers : attempt[w] = t /\ attempt'[w] # t

Advanced(t) == Rank[task'[t].step] > Rank[task[t].step] \/ (task'[t].state = "done" /\ task[t].state # "done")

OneLiveAttempt == \A t \in Tasks : Cardinality(LiveOn(t)) <= 1

LiveAttemptMeansReady == \A w \in Workers : attempt[w] # NoTask => task[attempt[w]].state = "ready"

LiveAttemptIsCurrent == \A w \in Workers : attempt[w] # NoTask => claimEpoch[w] = humanActions[attempt[w]]

AttemptRunsAsAPerson == \A w \in Workers : attempt[w] # NoTask => runAs[w]

OutputsSurvive == \A t \in Tasks : \A s \in StepSet : Rank[s] < Rank[task[t].step] => s \in task[t].outputs

RoundsCapped == \A t \in Tasks : \A r \in Returning : task[t].rounds[r] <= MaxRounds

EnvRerunsCapped == \A t \in Tasks : task[t].reruns <= MaxEnvReruns

LostAttemptsCapped == \A t \in Tasks : task[t].lost <= MaxLost

StageRetriesCapped == \A t \in Tasks : task[t].retries <= MaxStageRetries

InputWaitsCapped == \A t \in Tasks : task[t].inputWaits <= MaxInputWaits

PassLeavesNoStageRetries == \A t \in Tasks : task[t].passed => task[t].retries = 0

StopsAtItsEndStage == \A t \in Tasks : Rank[task[t].step] <= Rank[task[t].end] /\ (task[t].state = "done" => task[t].step = task[t].end)

ApprovalsMatchGatesPassed ==
    \A t \in Tasks : LET passedGates == {g \in Gates(t) : Rank[g] < Rank[task[t].step]}
                    IN task[t].missing \subseteq passedGates /\ task[t].approved = passedGates \ task[t].missing

ReviewReturnsCapped == \A t \in Tasks : task[t].reviews <= MaxReviewReturns

StoppedTaskCanResume ==
    \A t \in Tasks : task[t].state = "stopped" =>
        LET resumed == Resumed(task[t])
        IN /\ "stopped" \in RetriesFrom
           /\ resumed.state \in {"ready", "gated"}
           /\ resumed.step = task[t].step
           /\ resumed.outputs = task[t].outputs
           /\ resumed.approved = task[t].approved
           /\ resumed.reviews = task[t].reviews

GateStopResumesAtGate ==
    [][\A t \in Tasks : StoppedAtGate(task[t]) /\ task'[t].state # "stopped" =>
          task'[t].state = "gated" /\ task'[t].step = task[t].step /\ task'[t].passed]_vars

TaskChangesOnlyWithItsAttempt ==
    [][\A t \in Tasks : task'[t] # task[t] => AttemptEndsOn(t) \/ PersonActsOn(t) \/ OutsideApproves(t) \/ FoundNoOne(t) \/ ApprovalGoesMissing(t)]_vars

AttemptEndsOnlyWithItsTask == [][\A t \in Tasks : AttemptEndsOn(t) => task'[t] # task[t] \/ PersonActsOn(t)]_vars

FailedRoundReturnsToImplement ==
    [][\A t \in Tasks : \A r \in Returning : task'[t].rounds[r] > task[t].rounds[r] =>
          task'[t].step = ReturnsTo \/ task'[t].state = "waiting"]_vars

LateWriteChangesNothing == [][lateResults' \subseteq lateResults /\ lateResults' # lateResults => UNCHANGED <<task, attempt, worker>>]_vars

OutputsOnlyGrow == [][\A t \in Tasks : task[t].outputs \subseteq task'[t].outputs]_vars

StageAdvancesOnlyOnPass == [][\A t \in Tasks : Advanced(t) => task'[t].passed]_vars

DoneIsFinal == [][\A t \in Tasks : task[t].state = "done" => task'[t] = task[t]]_vars

StageMovesOneStep ==
    [][\A t \in Tasks : task'[t].step # task[t].step =>
          \/ Rank[task'[t].step] = Rank[task[t].step] + 1
          \/ task[t].step \in Returning /\ task'[t].step = ReturnsTo]_vars

OnlyAPersonStops == [][\A t \in Tasks : task'[t].state = "stopped" /\ task[t].state # "stopped" => PersonActsOn(t)]_vars

RetryLeavesNoStageRetries == [][\A t \in Tasks : PersonActsOn(t) /\ task'[t].state = "ready" => task'[t].retries = 0]_vars

GatePassesOnlyOnApprove ==
    [][\A t \in Tasks : \A g \in Gates(t) :
          Rank[task[t].step] <= Rank[g] /\ Rank[task'[t].step] > Rank[g] => PersonActsOn(t) /\ g \in task'[t].approved]_vars

MergeNeedsEveryGate ==
    [][\A t \in Tasks : task[t].step \in Merges /\ task[t].state # "done" /\ task'[t].state = "done" =>
          task'[t].passed /\ Gates(t) \subseteq task[t].approved]_vars

ReviewsOnlyGrow == [][\A t \in Tasks : task'[t].reviews >= task[t].reviews]_vars

LaterReviewWaitsForAPerson ==
    [][\A w \in Workers : \A t \in Tasks :
          attempt[w] = t /\ task[t].step \in Merges /\ task[t].reviews >= MaxReviewReturns /\ Finishes(w, "changesRequested") =>
              (task'[t].state = "waiting" <=> t \notin IgnoreLaterReviews)]_vars

EndStagePassIsDone ==
    [][\A w \in Workers : \A t \in Tasks :
          attempt[w] = t /\ task[t].step = task[t].end /\ Gates(t) \subseteq task[t].approved /\ Finishes(w, "pass") =>
              task'[t].state = "done"]_vars

ReleasedOnlyAfterItsLease == [][\A t \in Tasks : task'[t].lost > task[t].lost => \E w \in Workers : attempt[w] = t /\ worker[w] = "hung"]_vars

LapsedLeaseNeverRenews == [][\A w \in Workers : worker[w] = "hung" => worker'[w] # "busy"]_vars

EveryTaskSettles == \A t \in Tasks : <>[](task[t].state \in Settled)

=============================================================================

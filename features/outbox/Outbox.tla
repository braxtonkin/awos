------------------------------- MODULE Outbox -------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tasks,
    Performers,
    NoRow,
    RowsPerTask,
    MaxTries,
    MaxCrashes,
    MaxStalls,
    MaxRetries,
    EnqueueWithState,
    ClaimIsExclusive,
    MarkerCheckedBeforeWrite,
    LeaseExpires,
    InOrderPerTask,
    ClaimWaitsForOwedActions,
    DoneFollowsEffect,
    EffectWithinLease,
    FailedCallKeepsClaim,
    RetriesAreCapped,
    FailureParksTask,
    FailureKeepsReview,
    RetryReowesFailedRows,
    LeasesOnOneClock,
    TargetSettlesWithinMargin,
    PerformerIsFair

ASSUME RowsPerTask \in Nat \ {0} /\ MaxTries \in Nat \ {0} /\ MaxCrashes \in Nat /\ MaxStalls \in Nat /\ MaxRetries \in Nat

VARIABLES task, review, row, effects, pending, perf, crashes, stalls, retries

vars == <<task, review, row, effects, pending, perf, crashes, stalls, retries>>

Rows == Tasks \X (1..RowsPerTask)

TaskStates == {"working", "owing", "review", "rolledBack", "next", "waiting"}

ReviewStates == {"none", "open"}

RowStates == {"absent", "owed", "done", "failed"}

Steps == {"idle", "check", "call", "mark"}

RowsOf(t) == {t} \X (1..RowsPerTask)

Earlier(r) == {e \in RowsOf(r[1]) : e[2] < r[2]}

Min(a, b) == IF a < b THEN a ELSE b

KeyedFirst == CHOOSE t \in Tasks : TRUE

Keyed(r) == IF r[1] = KeyedFirst THEN r[2] % 2 = 1 ELSE r[2] % 2 = 0

Idle == [step |-> "idle", row |-> NoRow, live |-> FALSE, stalled |-> FALSE]

Holders(r) == {p \in Performers : perf[p].row = r /\ perf[p].live}

FirstStep(r) == IF MarkerCheckedBeforeWrite /\ ~Keyed(r) THEN "check" ELSE "call"

TypeOK ==
    /\ task \in [Tasks -> TaskStates]
    /\ review \in [Tasks -> ReviewStates]
    /\ row \in [Rows -> [state : RowStates, tries : 0..MaxTries, leased : BOOLEAN]]
    /\ effects \in [Rows -> 0..2]
    /\ pending \subseteq Rows
    /\ perf \in [Performers -> [step : Steps, row : Rows \cup {NoRow}, live : BOOLEAN, stalled : BOOLEAN]]
    /\ crashes \in 0..MaxCrashes
    /\ stalls \in 0..MaxStalls
    /\ retries \in 0..MaxRetries

Init ==
    /\ task = [t \in Tasks |-> "working"]
    /\ review = [t \in Tasks |-> "none"]
    /\ row = [r \in Rows |-> [state |-> "absent", tries |-> 0, leased |-> FALSE]]
    /\ effects = [r \in Rows |-> 0]
    /\ pending = {}
    /\ perf = [p \in Performers |-> Idle]
    /\ crashes = 0
    /\ stalls = 0
    /\ retries = 0

Landed(r) == IF Keyed(r) /\ effects[r] > 0 THEN effects ELSE [effects EXCEPT ![r] = Min(@ + 1, 2)]

Owed(t) == [r \in Rows |-> IF r[1] = t THEN [row[r] EXCEPT !.state = "owed"] ELSE row[r]]

Reowed(t) == [r \in Rows |-> IF r[1] = t /\ row[r].state = "failed" THEN [row[r] EXCEPT !.state = "owed", !.tries = 0] ELSE row[r]]

Released(r) == [row[r] EXCEPT !.leased = FALSE]

Done(r) == [Released(r) EXCEPT !.state = IF @ = "owed" THEN "done" ELSE @]

LostTry(r) ==
    LET tried == row[r].tries + 1
    IN IF row[r].state # "owed"
       THEN Released(r)
       ELSE [Released(r) EXCEPT !.tries = Min(tried, MaxTries),
                                !.state = IF RetriesAreCapped /\ tried >= MaxTries THEN "failed" ELSE "owed"]

Parks(t) == FailureParksTask /\ (FailureKeepsReview => task[t] # "review")

ParkedAfter(r, lost) == IF lost.state = "failed" /\ row[r].state = "owed" /\ Parks(r[1]) THEN [task EXCEPT ![r[1]] = "waiting"] ELSE task

Transact(t) ==
    /\ task[t] = "working"
    /\ \E commits, enqueued, gated \in BOOLEAN :
         /\ EnqueueWithState => enqueued = commits
         /\ task' = [task EXCEPT ![t] = IF ~commits THEN "rolledBack" ELSE IF gated THEN "review" ELSE "owing"]
         /\ review' = [review EXCEPT ![t] = IF commits /\ gated THEN "open" ELSE "none"]
         /\ row' = IF enqueued THEN Owed(t) ELSE row
    /\ UNCHANGED <<effects, pending, perf, crashes, stalls, retries>>

ClaimNextStage(t) ==
    /\ task[t] = "owing"
    /\ ClaimWaitsForOwedActions => \A r \in RowsOf(t) : row[r].state # "owed"
    /\ task' = [task EXCEPT ![t] = "next"]
    /\ UNCHANGED <<review, row, effects, pending, perf, crashes, stalls, retries>>

Approve(t) ==
    /\ task[t] = "review"
    /\ task' = [task EXCEPT ![t] = "owing"]
    /\ review' = [review EXCEPT ![t] = "none"]
    /\ row' = IF RetryReowesFailedRows THEN Reowed(t) ELSE row
    /\ UNCHANGED <<effects, pending, perf, crashes, stalls, retries>>

Retry(t) ==
    /\ task[t] = "waiting"
    /\ retries < MaxRetries
    /\ task' = [task EXCEPT ![t] = "owing"]
    /\ row' = IF RetryReowesFailedRows THEN Reowed(t) ELSE row
    /\ retries' = retries + 1
    /\ UNCHANGED <<review, effects, pending, perf, crashes, stalls>>

Claim(p, r) ==
    /\ perf[p].step = "idle"
    /\ row[r].state = "owed"
    /\ ClaimIsExclusive => ~row[r].leased
    /\ InOrderPerTask => \A e \in Earlier(r) : row[e].state = "done"
    /\ row' = [row EXCEPT ![r].leased = TRUE, ![r].state = IF DoneFollowsEffect THEN @ ELSE "done"]
    /\ perf' = [perf EXCEPT ![p] = [step |-> FirstStep(r), row |-> r, live |-> TRUE, stalled |-> FALSE]]
    /\ UNCHANGED <<task, review, effects, pending, crashes, stalls, retries>>

Check(p) ==
    LET r == perf[p].row
    IN /\ perf[p].step = "check"
       /\ ~perf[p].stalled
       /\ IF effects[r] > 0
          THEN /\ row' = [row EXCEPT ![r] = Done(r)]
               /\ perf' = [perf EXCEPT ![p] = Idle]
          ELSE /\ perf' = [perf EXCEPT ![p].step = "call"]
               /\ UNCHANGED row
       /\ UNCHANGED <<task, review, effects, pending, crashes, stalls, retries>>

Call(p) ==
    LET r == perf[p].row
        lost == LostTry(r)
    IN /\ perf[p].step = "call"
       /\ ~perf[p].stalled
       /\ EffectWithinLease => perf[p].live
       /\ \/ /\ effects' = Landed(r)
             /\ perf' = [perf EXCEPT ![p].step = "mark"]
             /\ UNCHANGED <<task, review, row, pending>>
          \/ /\ pending' = pending \cup {r}
             /\ perf' = [perf EXCEPT ![p] = Idle]
             /\ IF FailedCallKeepsClaim
                THEN UNCHANGED <<task, review, row>>
                ELSE /\ row' = [row EXCEPT ![r] = lost]
                     /\ task' = ParkedAfter(r, lost)
                     /\ UNCHANGED review
             /\ UNCHANGED effects
       /\ UNCHANGED <<crashes, stalls, retries>>

Mark(p) ==
    LET r == perf[p].row
    IN /\ perf[p].step = "mark"
       /\ ~perf[p].stalled
       /\ row' = [row EXCEPT ![r] = Done(r)]
       /\ perf' = [perf EXCEPT ![p] = Idle]
       /\ UNCHANGED <<task, review, effects, pending, crashes, stalls, retries>>

Abandon(p) ==
    /\ perf[p].step = "call"
    /\ EffectWithinLease
    /\ ~perf[p].stalled
    /\ ~perf[p].live
    /\ perf' = [perf EXCEPT ![p] = Idle]
    /\ UNCHANGED <<task, review, row, effects, pending, crashes, stalls, retries>>

Crash(p) ==
    /\ perf[p].step # "idle"
    /\ crashes < MaxCrashes
    /\ perf' = [perf EXCEPT ![p] = Idle]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<task, review, row, effects, pending, stalls, retries>>

Hang(p) ==
    /\ perf[p].step = "call"
    /\ ~perf[p].stalled
    /\ stalls < MaxStalls
    /\ perf' = [perf EXCEPT ![p].stalled = TRUE]
    /\ stalls' = stalls + 1
    /\ UNCHANGED <<task, review, row, effects, pending, crashes, retries>>

Wake(p) ==
    /\ perf[p].stalled
    /\ perf' = [perf EXCEPT ![p].stalled = FALSE]
    /\ UNCHANGED <<task, review, row, effects, pending, crashes, stalls, retries>>

Resolve(r) ==
    /\ r \in pending
    /\ pending' = pending \ {r}
    /\ \/ effects' = Landed(r)
       \/ UNCHANGED effects
    /\ UNCHANGED <<task, review, row, perf, crashes, stalls, retries>>

Expire(r) ==
    LET lost == LostTry(r)
    IN /\ LeaseExpires
       /\ row[r].leased
       /\ TargetSettlesWithinMargin => r \notin pending
       /\ LeasesOnOneClock => \A p \in Holders(r) : perf[p].stalled
       /\ row' = [row EXCEPT ![r] = lost]
       /\ task' = ParkedAfter(r, lost)
       /\ perf' = IF LeasesOnOneClock THEN [p \in Performers |-> IF perf[p].row = r THEN [perf[p] EXCEPT !.live = FALSE] ELSE perf[p]] ELSE perf
       /\ UNCHANGED <<review, effects, pending, crashes, stalls, retries>>

Quiet == \A p \in Performers : perf[p].step = "idle"

Next ==
    \/ \E t \in Tasks : Transact(t) \/ ClaimNextStage(t) \/ Approve(t) \/ Retry(t)
    \/ \E p \in Performers, r \in Rows : Claim(p, r)
    \/ \E p \in Performers : Check(p) \/ Call(p) \/ Mark(p) \/ Abandon(p)
    \/ \E p \in Performers : Crash(p) \/ Hang(p) \/ Wake(p)
    \/ \E r \in Rows : Resolve(r) \/ Expire(r)
    \/ Quiet /\ UNCHANGED vars

Performing(p) == Check(p) \/ Call(p) \/ Mark(p) \/ Abandon(p) \/ Wake(p)

PerformersProgress ==
    /\ \A r \in Rows : WF_vars(\E p \in Performers : Claim(p, r))
    /\ \A p \in Performers : WF_vars(Performing(p))

TargetsProgress == \A r \in Rows : WF_vars(Resolve(r)) /\ WF_vars(Expire(r))

Spec == Init /\ [][Next]_vars /\ TargetsProgress /\ (IF PerformerIsFair THEN PerformersProgress ELSE TRUE)

EffectAtMostOnce == \A r \in Rows : effects[r] <= 1

DoneMeansEffect == \A r \in Rows : row[r].state = "done" => effects[r] > 0

NoEffectWithoutOwingState == \A r \in Rows : effects[r] > 0 => task[r[1]] # "rolledBack"

ActionsInOrderPerTask == \A r \in Rows : effects[r] > 0 => \A e \in Earlier(r) : effects[e] > 0

NextStageWaitsForOwedActions == \A t \in Tasks : task[t] = "next" => \A r \in RowsOf(t) : row[r].state = "done"

OneLivePerformerPerRow == \A r \in Rows : Cardinality(Holders(r)) <= 1

ReviewKeptUntilDecided == \A t \in Tasks : review[t] = "open" => task[t] = "review"

HeldForAPerson(r) == task[r[1]] = "waiting" \/ (task[r[1]] = "review" /\ \E e \in Earlier(r) : row[e].state = "failed")

EveryOwedActionSettles == \A r \in Rows : <>[](row[r].state # "owed" \/ HeldForAPerson(r))

=============================================================================

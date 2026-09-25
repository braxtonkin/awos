------------------------------ MODULE Requests ------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Targets,
    Engines,
    NoTarget,
    RequestsPerTarget,
    MaxRepeats,
    MaxCrashes,
    KeyFollowsCommitOrder,
    RepeatReusesTheRow,
    ClaimTakesOldestOfTarget,
    ApplyAndAnswerAreOneStep,
    FailureIsAnswered,
    AnswerWrittenOnce,
    EngineIsFair

ASSUME RequestsPerTarget \in Nat \ {0} /\ MaxRepeats \in Nat /\ MaxCrashes \in Nat

VARIABLES sent, rows, applied, engine, repeats, crashes

vars == <<sent, rows, applied, engine, repeats, crashes>>

Requests == 1..RequestsPerTarget

Positions == 1..(RequestsPerTarget + MaxRepeats)

Answers == {"absent", "open", "recorded", "refused"}

Verdicts == {"recorded", "refused"}

Steps == {"idle", "locked", "applied", "failed"}

Idle == [step |-> "idle", target |-> NoTarget, row |-> 0]

Absent == [request |-> 0, answer |-> "absent"]

Open(t, i) == rows[t][i].answer = "open"

Answered(t, i) == rows[t][i].answer \in Verdicts

Present(t) == {i \in Positions : rows[t][i].answer # "absent"}

Holds(e, t, i) == engine[e].step = "locked" /\ engine[e].target = t /\ engine[e].row = i

Locked(t, i) == \E e \in Engines : Holds(e, t, i)

Claimable(t, i) ==
    /\ Open(t, i)
    /\ ~Locked(t, i)
    /\ \A j \in 1..(i - 1) : ~Open(t, j) \/ (~ClaimTakesOldestOfTarget /\ Locked(t, j))

Keys(t) == IF KeyFollowsCommitOrder THEN {Cardinality(Present(t)) + 1} ELSE Positions \ Present(t)

Insert(t, request) == \E i \in Keys(t) : rows' = [rows EXCEPT ![t][i] = [request |-> request, answer |-> "open"]]

TypeOK ==
    /\ sent \in [Targets -> 0..RequestsPerTarget]
    /\ rows \in [Targets -> [Positions -> [request : 0..RequestsPerTarget, answer : Answers]]]
    /\ applied \in [Targets -> [Requests -> 0..2]]
    /\ engine \in [Engines -> [step : Steps, target : Targets \cup {NoTarget}, row : 0..(RequestsPerTarget + MaxRepeats)]]
    /\ repeats \in 0..MaxRepeats
    /\ crashes \in 0..MaxCrashes

Init ==
    /\ sent = [t \in Targets |-> 0]
    /\ rows = [t \in Targets |-> [i \in Positions |-> Absent]]
    /\ applied = [t \in Targets |-> [r \in Requests |-> 0]]
    /\ engine = [e \in Engines |-> Idle]
    /\ repeats = 0
    /\ crashes = 0

Send(t) ==
    /\ sent[t] < RequestsPerTarget
    /\ sent' = [sent EXCEPT ![t] = @ + 1]
    /\ Insert(t, sent[t] + 1)
    /\ UNCHANGED <<applied, engine, repeats, crashes>>

Repeat(t, request) ==
    /\ request <= sent[t]
    /\ IF RepeatReusesTheRow
       THEN UNCHANGED vars
       ELSE /\ repeats < MaxRepeats
            /\ repeats' = repeats + 1
            /\ Insert(t, request)
            /\ UNCHANGED <<sent, applied, engine, crashes>>

Claim(e, t, i) ==
    /\ engine[e].step = "idle"
    /\ Claimable(t, i)
    /\ engine' = [engine EXCEPT ![e] = [step |-> "locked", target |-> t, row |-> i]]
    /\ UNCHANGED <<sent, rows, applied, repeats, crashes>>

Handled(e) ==
    LET t == engine[e].target
        request == rows[t][engine[e].row].request
    IN [applied EXCEPT ![t][request] = IF @ < 2 THEN @ + 1 ELSE @]

WriteAnswer(e, verdict) ==
    LET t == engine[e].target
        i == engine[e].row
    IN IF AnswerWrittenOnce /\ ~Open(t, i)
       THEN UNCHANGED rows
       ELSE rows' = [rows EXCEPT ![t][i].answer = verdict]

Apply(e) ==
    /\ engine[e].step = "locked"
    /\ applied' = Handled(e)
    /\ IF ApplyAndAnswerAreOneStep
       THEN /\ \E verdict \in Verdicts : rows' = [rows EXCEPT ![engine[e].target][engine[e].row].answer = verdict]
            /\ engine' = [engine EXCEPT ![e] = Idle]
       ELSE /\ engine' = [engine EXCEPT ![e].step = "applied"]
            /\ UNCHANGED rows
    /\ UNCHANGED <<sent, repeats, crashes>>

Answer(e) ==
    /\ engine[e].step = "applied"
    /\ \E verdict \in Verdicts : WriteAnswer(e, verdict)
    /\ engine' = [engine EXCEPT ![e] = Idle]
    /\ UNCHANGED <<sent, applied, repeats, crashes>>

Fail(e) ==
    /\ engine[e].step = "locked"
    /\ engine' = [engine EXCEPT ![e] = IF FailureIsAnswered THEN [engine[e] EXCEPT !.step = "failed"] ELSE Idle]
    /\ UNCHANGED <<sent, rows, applied, repeats, crashes>>

Refuse(e) ==
    /\ engine[e].step = "failed"
    /\ ~Locked(engine[e].target, engine[e].row)
    /\ WriteAnswer(e, "refused")
    /\ engine' = [engine EXCEPT ![e] = Idle]
    /\ UNCHANGED <<sent, applied, repeats, crashes>>

Crash(e) ==
    /\ engine[e].step # "idle"
    /\ crashes < MaxCrashes
    /\ engine' = [engine EXCEPT ![e] = Idle]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<sent, rows, applied, repeats>>

Quiet == \A e \in Engines : engine[e].step = "idle"

Works(e) == (\E t \in Targets, i \in Positions : Claim(e, t, i)) \/ Apply(e) \/ Answer(e) \/ Refuse(e)

Next ==
    \/ \E t \in Targets : Send(t) \/ \E request \in Requests : Repeat(t, request)
    \/ \E e \in Engines : Works(e) \/ Fail(e) \/ Crash(e)
    \/ Quiet /\ UNCHANGED vars

EnginesProgress == \A e \in Engines : WF_vars(Works(e))

Spec == Init /\ [][Next]_vars /\ (IF EngineIsFair THEN EnginesProgress ELSE TRUE)

RequestAppliedOnce == \A t \in Targets, request \in Requests : applied[t][request] <= 1

RequestsApplyInOrder == \A t \in Targets, i \in Positions : Answered(t, i) => \A j \in 1..(i - 1) : ~Open(t, j)

AnswerIsFinal == [][\A t \in Targets, i \in Positions : Answered(t, i) => rows'[t][i].answer = rows[t][i].answer]_vars

EveryRequestAnswered == \A t \in Targets, i \in Positions : Open(t, i) ~> ~Open(t, i)

=============================================================================

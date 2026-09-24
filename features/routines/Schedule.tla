------------------------------ MODULE Schedule ------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Routines,
    Engines,
    Keys,
    Slots,
    MaxCrashes,
    MaxHumanActions,
    Idle,
    SlotClaimIsExclusive,
    PauseIsChecked,
    CatchUpCollapses,
    TaskKeyIsUnique,
    RecordKeepsOwner,
    RunLeaseExpires,
    LateFinishIsRefused,
    RunRefreshesAssignee,
    RunNowIsKeyed,
    SchedulerIsFair

ASSUME Slots \in Nat \ {0} /\ MaxCrashes \in Nat /\ MaxHumanActions \in Nat

VARIABLES now, newest, runNow, asked, engine, task, finder, unseen, paused, crashes, humanActions

vars == <<now, newest, runNow, asked, engine, task, finder, unseen, paused, crashes, humanActions>>

RunSlots == {"newest", "earlier", "runNow"}

Leased == {"newest", "runNow"}

TypeOK ==
    /\ now \in 1..Slots
    /\ newest \in [Routines -> {"none", "live", "expired", "done"}]
    /\ runNow \in [Routines -> {"none", "live", "expired"}]
    /\ asked \in [Routines -> 0..2]
    /\ engine \in [Engines -> {Idle} \cup [routine : Routines, slot : RunSlots, lapsed : BOOLEAN]]
    /\ task \in [Keys -> [Routines -> {"none", "current", "outdated"}]]
    /\ finder \in [Keys -> SUBSET Routines]
    /\ unseen \in [Keys -> [Routines -> BOOLEAN]]
    /\ paused \in [Routines -> BOOLEAN]
    /\ crashes \in 0..MaxCrashes
    /\ humanActions \in 0..MaxHumanActions

Init ==
    /\ now = 1
    /\ newest = [r \in Routines |-> "none"]
    /\ runNow = [r \in Routines |-> "none"]
    /\ asked = [r \in Routines |-> 0]
    /\ engine = [e \in Engines |-> Idle]
    /\ task = [k \in Keys |-> [r \in Routines |-> "none"]]
    /\ finder = [k \in Keys |-> {}]
    /\ unseen = [k \in Keys |-> [r \in Routines |-> FALSE]]
    /\ paused = [r \in Routines |-> FALSE]
    /\ crashes = 0
    /\ humanActions = 0

Holds(e, r, s) == engine[e] # Idle /\ engine[e].routine = r /\ engine[e].slot = s

Current(e) == engine[e] # Idle /\ ~engine[e].lapsed

Busy(r) ==
    \/ newest[r] = "live"
    \/ runNow[r] = "live"
    \/ \E e \in Engines : Current(e) /\ engine[e].routine = r

Contested == IF SlotClaimIsExclusive THEN {} ELSE {"live"}

Claimable(r, s) ==
    CASE s = "newest" -> newest[r] \in {"none", "expired"} \cup Contested
      [] s = "earlier" -> ~CatchUpCollapses /\ now > 1
      [] s = "runNow" -> (runNow[r] = "none" /\ asked[r] > 0) \/ runNow[r] \in {"expired"} \cup Contested

Expired(r, s) ==
    /\ newest' = IF s = "newest" THEN [newest EXCEPT ![r] = "expired"] ELSE newest
    /\ runNow' = IF s = "runNow" THEN [runNow EXCEPT ![r] = "expired"] ELSE runNow

Tick ==
    /\ now < Slots
    /\ now' = now + 1
    /\ newest' = [r \in Routines |-> "none"]
    /\ engine' = [e \in Engines |-> IF engine[e] # Idle /\ engine[e].slot = "newest" THEN [engine[e] EXCEPT !.slot = "earlier"] ELSE engine[e]]
    /\ UNCHANGED <<runNow, asked, task, finder, unseen, paused, crashes, humanActions>>

Pause(r) ==
    /\ humanActions < MaxHumanActions
    /\ ~paused[r]
    /\ paused' = [paused EXCEPT ![r] = TRUE]
    /\ humanActions' = humanActions + 1
    /\ UNCHANGED <<now, newest, runNow, asked, engine, task, finder, unseen, crashes>>

Resume(r) ==
    /\ humanActions < MaxHumanActions
    /\ paused[r]
    /\ paused' = [paused EXCEPT ![r] = FALSE]
    /\ humanActions' = humanActions + 1
    /\ UNCHANGED <<now, newest, runNow, asked, engine, task, finder, unseen, crashes>>

Press(r) ==
    /\ humanActions < MaxHumanActions
    /\ asked[r] < 2
    /\ asked' = [asked EXCEPT ![r] = IF RunNowIsKeyed THEN 1 ELSE @ + 1]
    /\ humanActions' = humanActions + 1
    /\ UNCHANGED <<now, newest, runNow, engine, task, finder, unseen, paused, crashes>>

Reassign(k) ==
    /\ \E r \in Routines : task[k][r] = "current"
    /\ task' = [task EXCEPT ![k] = [r \in Routines |-> IF task[k][r] = "none" THEN "none" ELSE "outdated"]]
    /\ unseen' = [unseen EXCEPT ![k] = [r \in Routines |-> task[k][r] # "none"]]
    /\ UNCHANGED <<now, newest, runNow, asked, engine, finder, paused, crashes, humanActions>>

Claim(e, r, s) ==
    /\ engine[e] = Idle
    /\ PauseIsChecked => ~paused[r]
    /\ SlotClaimIsExclusive => ~Busy(r)
    /\ Claimable(r, s)
    /\ newest' = IF s = "newest" THEN [newest EXCEPT ![r] = "live"] ELSE newest
    /\ runNow' = IF s = "runNow" THEN [runNow EXCEPT ![r] = "live"] ELSE runNow
    /\ asked' = IF s = "runNow" /\ runNow[r] = "none" THEN [asked EXCEPT ![r] = @ - 1] ELSE asked
    /\ engine' = [engine EXCEPT ![e] = [routine |-> r, slot |-> s, lapsed |-> FALSE]]
    /\ UNCHANGED <<now, task, finder, unseen, paused, crashes, humanActions>>

Recorded(t, r) ==
    IF t[r] # "none"
    THEN IF RunRefreshesAssignee THEN [t EXCEPT ![r] = "current"] ELSE t
    ELSE IF TaskKeyIsUnique /\ \E x \in Routines : t[x] # "none"
         THEN IF RecordKeepsOwner THEN t ELSE [x \in Routines |-> IF x = r THEN "current" ELSE "none"]
         ELSE [t EXCEPT ![r] = "current"]

Finish(e) ==
    /\ engine[e] # Idle
    /\ engine' = [engine EXCEPT ![e] = Idle]
    /\ IF LateFinishIsRefused /\ engine[e].lapsed
       THEN UNCHANGED <<newest, runNow, task, finder, unseen>>
       ELSE LET r == engine[e].routine
                s == engine[e].slot
            IN /\ \E found \in SUBSET Keys :
                    /\ task' = [k \in Keys |-> IF k \in found THEN Recorded(task[k], r) ELSE task[k]]
                    /\ finder' = [k \in Keys |-> IF k \in found /\ finder[k] = {} THEN {r} ELSE finder[k]]
                    /\ unseen' = [k \in Keys |-> IF k \in found THEN [unseen[k] EXCEPT ![r] = FALSE] ELSE unseen[k]]
               /\ newest' = IF s = "newest" THEN [newest EXCEPT ![r] = "done"] ELSE newest
               /\ runNow' = IF s = "runNow" THEN [runNow EXCEPT ![r] = "none"] ELSE runNow
    /\ UNCHANGED <<now, asked, paused, crashes, humanActions>>

Crash(e) ==
    /\ engine[e] # Idle
    /\ crashes < MaxCrashes
    /\ engine' = [engine EXCEPT ![e] = Idle]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<now, newest, runNow, asked, task, finder, unseen, paused, humanActions>>

Lapse(e) ==
    /\ RunLeaseExpires
    /\ Current(e)
    /\ engine[e].slot \in Leased
    /\ crashes < MaxCrashes
    /\ Expired(engine[e].routine, engine[e].slot)
    /\ engine' = [engine EXCEPT ![e].lapsed = TRUE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<now, asked, task, finder, unseen, paused, humanActions>>

Expire(r, s) ==
    /\ RunLeaseExpires
    /\ ~\E e \in Engines : Current(e) /\ Holds(e, r, s)
    /\ (IF s = "newest" THEN newest[r] ELSE runNow[r]) = "live"
    /\ Expired(r, s)
    /\ UNCHANGED <<now, asked, engine, task, finder, unseen, paused, crashes, humanActions>>

Ended == now = Slots /\ humanActions = MaxHumanActions

Next ==
    \/ Tick
    \/ \E r \in Routines : Pause(r) \/ Resume(r) \/ Press(r)
    \/ \E k \in Keys : Reassign(k)
    \/ \E e \in Engines, r \in Routines, s \in RunSlots : Claim(e, r, s)
    \/ \E e \in Engines : Finish(e) \/ Crash(e) \/ Lapse(e)
    \/ \E r \in Routines, s \in Leased : Expire(r, s)
    \/ Ended /\ UNCHANGED vars

Works(e) == (\E r \in Routines, s \in RunSlots : Claim(e, r, s)) \/ Finish(e)

TimePasses == WF_vars(Tick) /\ WF_vars(\E r \in Routines, s \in Leased : Expire(r, s))

SchedulerProgress == \A e \in Engines : WF_vars(Works(e))

Spec == Init /\ [][Next]_vars /\ TimePasses /\ (IF SchedulerIsFair THEN SchedulerProgress ELSE TRUE)

Starts(e) == engine[e] = Idle /\ engine'[e] # Idle

CaughtUp(r) == newest[r] = "done" /\ runNow[r] = "none" /\ asked[r] = 0

OneRunPerSlot ==
    \A e \in Engines : Current(e) =>
        /\ engine[e].slot = "newest" => newest[engine[e].routine] = "live"
        /\ engine[e].slot = "runNow" => runNow[engine[e].routine] = "live"
        /\ \A f \in Engines \ {e} : Current(f) => ~Holds(f, engine[e].routine, engine[e].slot)

RunNowRunsOnce == \A r \in Routines : asked[r] <= 1

OneTaskPerTicket == \A k \in Keys, r \in Routines : task[k][r] # "none" => finder[k] = {r}

AssigneeFollowsTicket == \A k \in Keys, r \in Routines : task[k][r] = "outdated" => unseen[k][r]

PausedRoutineStartsNoRun == [][\A e \in Engines : Starts(e) => ~paused[engine'[e].routine]]_vars

MissedSlotsCollapse == [][\A e \in Engines : Starts(e) => engine'[e].slot # "earlier"]_vars

DueSlotsRun == \A r \in Routines : []<>(paused[r] \/ CaughtUp(r))

=============================================================================

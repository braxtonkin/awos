------------------------------- MODULE Bridge -------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxEvents,
    MaxCommands,
    MaxEngineCrashes,
    MaxNetworkFaults,
    GapIsRefused,
    DuplicateIsDropped,
    AckFollowsCommit,
    BridgeResendsUnacked,
    CommandsAreNumbered,
    PruneKeepsHighWater,
    LostAttemptIsFenced,
    RestartGraceForLeases,
    FinishWaitsForLastLine,
    EngineIsFair,
    LapsedLeaseStaysLapsed

LinesPerStep == 3

ASSUME MaxEvents \in Nat /\ MaxEvents >= LinesPerStep /\ MaxCommands \in Nat /\ MaxEngineCrashes \in Nat /\ MaxNetworkFaults \in Nat

VARIABLES
    emitted,
    acked,
    applied,
    bridge,
    posts,
    stream,
    frames,
    engine,
    status,
    lease,
    highest,
    rows,
    commands,
    faults,
    crashes,
    timesStored,
    timesApplied

bridgeMemory == <<emitted, acked, applied>>

wire == <<posts, stream, frames>>

attemptRow == <<status, lease, highest>>

tables == <<rows, commands>>

budgets == <<faults, crashes>>

history == <<timesStored, timesApplied>>

vars == <<bridgeMemory, bridge, wire, engine, attemptRow, tables, budgets, history>>

Events == 1..MaxEvents

Commands == 1..MaxCommands

Ranges == {range \in Events \X Events : range[1] <= range[2]}

Max(a, b) == IF a > b THEN a ELSE b

Min(a, b) == IF a < b THEN a ELSE b

StepOf(n) == (n - 1) \div LinesPerStep

IsFinish(n) == n % LinesPerStep = 0

FragmentsOf(n) == {m \in Events : StepOf(m) = StepOf(n) /\ ~IsFinish(m)}

Kept(held, n) == IF IsFinish(n) THEN (held \ FragmentsOf(n)) \cup {n} ELSE held \cup {n}

HighestOf(store) == IF PruneKeepsHighWater THEN store.highest ELSE Cardinality(store.rows)

Insert(store, n) ==
    IF n \in store.rows
    THEN [store EXCEPT !.aborted = TRUE]
    ELSE [store EXCEPT !.rows = Kept(@, n),
                       !.highest = Max(@, n),
                       !.timesStored[n] = Min(@ + 1, 2)]

StoreOne(store, n) ==
    CASE store.stopped \/ store.aborted -> store
      [] n <= HighestOf(store) -> IF DuplicateIsDropped THEN store ELSE Insert(store, n)
      [] n = HighestOf(store) + 1 -> Insert(store, n)
      [] OTHER -> IF GapIsRefused THEN [store EXCEPT !.stopped = TRUE] ELSE Insert(store, n)

RECURSIVE StoreFrom(_, _, _)
StoreFrom(store, n, last) == IF n > last THEN store ELSE StoreFrom(StoreOne(store, n), n + 1, last)

Stored(range) ==
    StoreFrom([rows |-> rows, highest |-> highest, timesStored |-> timesStored, stopped |-> FALSE, aborted |-> FALSE], range[1], range[2])

Heard(store) == IF store.aborted \/ bridge # "up" THEN acked ELSE Max(acked, HighestOf(store))

HeardBeforeCrash(store) == IF AckFollowsCommit THEN acked ELSE Heard(store)

ResendFrom(after) == IF BridgeResendsUnacked /\ after < emitted THEN {<<after + 1, emitted>>} ELSE {}

Replay ==
    LET from == IF CommandsAreNumbered THEN applied ELSE 0
    IN [i \in 1..(commands - from) |-> from + i]

Fenced == LostAttemptIsFenced /\ status # "live"

CanFault == status = "live" /\ faults < MaxNetworkFaults

Deliveries == IF CanFault THEN {"once", "twice", "unanswered"} ELSE {"once"}

Ended == status # "live"

Lives == status = "live" /\ bridge = "up"

LinesExcused == status \in {"stopped", "lost"} \/ (status = "live" /\ bridge # "up")

TypeOK ==
    /\ emitted \in 0..MaxEvents
    /\ acked \in 0..MaxEvents
    /\ applied \in 0..MaxCommands
    /\ bridge \in {"up", "hung", "down"}
    /\ posts \subseteq Ranges
    /\ stream \in {"open", "closed"}
    /\ frames \in Seq(Commands)
    /\ engine \in {"up", "down"}
    /\ status \in {"live", "finished", "stopped", "lost"}
    /\ lease \in {"fresh", "lapsedInOutage", "lapsedInSilence"}
    /\ highest \in 0..MaxEvents
    /\ rows \subseteq Events
    /\ commands \in 0..MaxCommands
    /\ faults \in 0..MaxNetworkFaults
    /\ crashes \in 0..MaxEngineCrashes
    /\ timesStored \in [Events -> 0..2]
    /\ timesApplied \in [Commands -> 0..2]

Init ==
    /\ emitted = 0
    /\ acked = 0
    /\ applied = 0
    /\ bridge = "up"
    /\ posts = {}
    /\ stream = "closed"
    /\ frames = <<>>
    /\ engine = "up"
    /\ status = "live"
    /\ lease = "fresh"
    /\ highest = 0
    /\ rows = {}
    /\ commands = 0
    /\ faults = 0
    /\ crashes = 0
    /\ timesStored = [n \in Events |-> 0]
    /\ timesApplied = [k \in Commands |-> 0]

Answered(range, heard, twice) ==
    /\ acked' = heard
    /\ posts' = (IF twice THEN posts ELSE posts \ {range}) \cup (IF bridge = "up" /\ heard < range[2] THEN ResendFrom(heard) ELSE {})

Renewed == IF LapsedLeaseStaysLapsed /\ lease # "fresh" THEN lease ELSE "fresh"

Commit(store) ==
    /\ rows' = store.rows
    /\ highest' = store.highest
    /\ timesStored' = store.timesStored
    /\ lease' = Renewed

BridgeStops ==
    /\ bridge' = "down"
    /\ stream' = "closed"
    /\ frames' = <<>>

EngineGoesDown ==
    /\ engine = "up"
    /\ status = "live"
    /\ crashes < MaxEngineCrashes
    /\ engine' = "down"
    /\ crashes' = crashes + 1
    /\ stream' = "closed"
    /\ frames' = <<>>

Emit ==
    /\ bridge = "up"
    /\ emitted < MaxEvents
    /\ emitted' = emitted + 1
    /\ posts' = posts \cup {<<emitted + 1, emitted + 1>>}
    /\ UNCHANGED <<acked, applied, bridge, stream, frames, engine, attemptRow, tables, budgets, history>>

Store(range) ==
    /\ range \in posts
    /\ engine = "up"
    /\ ~Fenced
    /\ LET store == Stored(range)
       IN \E delivery \in Deliveries :
            /\ faults' = IF delivery = "once" THEN faults ELSE faults + 1
            /\ IF store.aborted THEN UNCHANGED <<rows, highest, timesStored, lease>> ELSE Commit(store)
            /\ Answered(range, IF delivery = "unanswered" THEN acked ELSE Heard(store), delivery = "twice")
    /\ UNCHANGED <<emitted, applied, bridge, stream, frames, engine, status, commands, crashes, timesApplied>>

CrashBeforeCommit(range) ==
    /\ range \in posts
    /\ EngineGoesDown
    /\ Answered(range, HeardBeforeCrash(Stored(range)), FALSE)
    /\ UNCHANGED <<emitted, applied, bridge, attemptRow, tables, faults, history>>

CrashAfterCommit(range) ==
    /\ range \in posts
    /\ EngineGoesDown
    /\ LET store == Stored(range)
       IN /\ ~store.aborted
          /\ Commit(store)
          /\ Answered(range, HeardBeforeCrash(store), FALSE)
    /\ UNCHANGED <<emitted, applied, bridge, status, commands, faults, timesApplied>>

EngineCrash ==
    /\ EngineGoesDown
    /\ UNCHANGED <<bridgeMemory, bridge, posts, attemptRow, tables, faults, history>>

RefusePost(range) ==
    /\ range \in posts
    /\ engine = "up"
    /\ Fenced
    /\ posts' = posts \ {range}
    /\ BridgeStops
    /\ UNCHANGED <<bridgeMemory, engine, attemptRow, tables, budgets, history>>

DropPost(range) ==
    /\ range \in posts
    /\ CanFault
    /\ faults' = faults + 1
    /\ Answered(range, acked, FALSE)
    /\ UNCHANGED <<emitted, applied, bridge, stream, frames, engine, attemptRow, tables, crashes, history>>

Restart ==
    /\ engine = "down"
    /\ engine' = "up"
    /\ lease' = IF RestartGraceForLeases THEN "fresh" ELSE lease
    /\ UNCHANGED <<bridgeMemory, bridge, wire, status, highest, tables, budgets, history>>

LeaseLapses ==
    /\ status = "live"
    /\ lease = "fresh"
    /\ (engine = "down" \/ bridge # "up")
    /\ lease' = IF engine = "down" THEN "lapsedInOutage" ELSE "lapsedInSilence"
    /\ UNCHANGED <<bridgeMemory, bridge, wire, engine, status, highest, tables, budgets, history>>

Reap ==
    /\ engine = "up"
    /\ status = "live"
    /\ lease # "fresh"
    /\ status' = "lost"
    /\ UNCHANGED <<bridgeMemory, bridge, wire, engine, lease, highest, tables, budgets, history>>

Finish ==
    /\ engine = "up"
    /\ status = "live"
    /\ FinishWaitsForLastLine => highest = MaxEvents
    /\ status' = "finished"
    /\ UNCHANGED <<bridgeMemory, bridge, wire, engine, lease, highest, tables, budgets, history>>

Stop ==
    /\ engine = "up"
    /\ status = "live"
    /\ status' = "stopped"
    /\ UNCHANGED <<bridgeMemory, bridge, wire, engine, lease, highest, tables, budgets, history>>

BridgeCrash ==
    /\ bridge # "down"
    /\ status = "live"
    /\ BridgeStops
    /\ UNCHANGED <<bridgeMemory, posts, engine, attemptRow, tables, budgets, history>>

Hang ==
    /\ bridge = "up"
    /\ CanFault
    /\ bridge' = "hung"
    /\ stream' = "closed"
    /\ frames' = <<>>
    /\ faults' = faults + 1
    /\ UNCHANGED <<bridgeMemory, posts, engine, attemptRow, tables, crashes, history>>

Wake ==
    /\ bridge = "hung"
    /\ bridge' = "up"
    /\ posts' = posts \cup ResendFrom(acked)
    /\ UNCHANGED <<bridgeMemory, stream, frames, engine, attemptRow, tables, budgets, history>>

Command ==
    /\ engine = "up"
    /\ commands < MaxCommands
    /\ ~Fenced
    /\ commands' = commands + 1
    /\ frames' = IF stream = "open" THEN Append(frames, commands + 1) ELSE frames
    /\ UNCHANGED <<bridgeMemory, bridge, posts, stream, engine, attemptRow, rows, budgets, history>>

OpenStream ==
    /\ bridge = "up"
    /\ stream = "closed"
    /\ engine = "up"
    /\ ~Fenced
    /\ stream' = "open"
    /\ \E echo \in IF Replay = <<>> THEN {FALSE} ELSE BOOLEAN :
         frames' = IF echo THEN Append(Replay, commands) ELSE Replay
    /\ lease' = Renewed
    /\ UNCHANGED <<bridgeMemory, bridge, posts, engine, status, highest, tables, budgets, history>>

RefuseStream ==
    /\ bridge = "up"
    /\ stream = "closed"
    /\ engine = "up"
    /\ Fenced
    /\ bridge' = "down"
    /\ UNCHANGED <<bridgeMemory, wire, engine, attemptRow, tables, budgets, history>>

Apply ==
    /\ bridge = "up"
    /\ frames # <<>>
    /\ frames' = Tail(frames)
    /\ IF CommandsAreNumbered /\ Head(frames) <= applied
       THEN UNCHANGED <<applied, timesApplied>>
       ELSE /\ applied' = Head(frames)
            /\ timesApplied' = [timesApplied EXCEPT ![Head(frames)] = Min(@ + 1, 2)]
    /\ UNCHANGED <<emitted, acked, bridge, posts, stream, engine, attemptRow, tables, budgets, timesStored>>

BreakStream ==
    /\ stream = "open"
    /\ CanFault
    /\ stream' = "closed"
    /\ frames' = <<>>
    /\ faults' = faults + 1
    /\ UNCHANGED <<bridgeMemory, bridge, posts, engine, attemptRow, tables, crashes, history>>

Next ==
    \/ Emit
    \/ \E range \in Ranges : Store(range)
    \/ \E range \in Ranges : CrashBeforeCommit(range)
    \/ \E range \in Ranges : CrashAfterCommit(range)
    \/ \E range \in Ranges : RefusePost(range)
    \/ \E range \in Ranges : DropPost(range)
    \/ EngineCrash
    \/ Restart
    \/ LeaseLapses
    \/ Reap
    \/ Finish
    \/ Stop
    \/ BridgeCrash
    \/ Hang
    \/ Wake
    \/ Command
    \/ OpenStream
    \/ RefuseStream
    \/ Apply
    \/ BreakStream
    \/ Ended /\ UNCHANGED vars

BridgeProgress == WF_vars(OpenStream \/ RefuseStream \/ Apply)

EngineProgress == WF_vars(Restart \/ \E range \in posts : Store(range))

Spec == Init /\ [][Next]_vars /\ BridgeProgress /\ (IF EngineIsFair THEN EngineProgress ELSE TRUE)

EmittedAreStored == \A n \in 1..emitted : timesStored[n] > 0

CommandsAreApplied == \A k \in 1..commands : timesApplied[k] > 0

NoEventStoredTwice == \A n \in Events : timesStored[n] <= 1

EventsStoredInOrder == \A n \in Events : timesStored[n] > 0 => \A m \in 1..(n - 1) : timesStored[m] > 0

AckedMeansStored == \A n \in 1..acked : timesStored[n] > 0

CommandAppliedOnce == \A k \in Commands : timesApplied[k] <= 1

FinishedStepKeepsItsText == \A n \in Events : IsFinish(n) /\ timesStored[n] > 0 => n \in rows /\ FragmentsOf(n) \cap rows = {}

ReconnectedBridgeKeepsItsAttempt == status = "lost" => lease = "lapsedInSilence"

LapsedLeaseNeverRenews == [][lease # "fresh" /\ engine = "up" => lease' = lease]_vars

CommandsAppliedInOrder == [][applied' # applied => applied' = applied + 1]_vars

LostAttemptChangesNothing == [][Ended => UNCHANGED <<rows, highest, timesStored, commands>> /\ Len(frames') <= Len(frames)]_vars

EveryEventStored == <>[](EmittedAreStored \/ LinesExcused)

EveryCommandApplied == <>[](CommandsAreApplied \/ ~Lives)

=============================================================================

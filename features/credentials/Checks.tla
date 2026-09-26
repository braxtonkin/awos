------------------------------- MODULE Checks -------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Checkers,
    MaxLogins,
    MaxRefreshes,
    MaxChecks,
    MaxCrashes,
    MaxJobs,
    ClaimIsExclusive,
    RefreshIsClaimedOnce,
    WriteBackNeedsOpenedLogin,
    JobCopyIsAccessOnly,
    DeathKeepsRefreshClaim,
    ClaimNeedsDueLogin,
    FinishNeedsClaim,
    ReapplyNeedsNewerLogin

ASSUME
    /\ Checkers # {}
    /\ MaxLogins \in Nat \ {0}
    /\ MaxRefreshes \in Nat
    /\ MaxChecks \in Nat
    /\ MaxCrashes \in Nat
    /\ MaxJobs \in Nat
    /\ {ClaimIsExclusive, RefreshIsClaimedOnce, WriteBackNeedsOpenedLogin, JobCopyIsAccessOnly, DeathKeepsRefreshClaim, ClaimNeedsDueLogin, FinishNeedsClaim, ReapplyNeedsNewerLogin} \subseteq BOOLEAN

VARIABLES issued, logins, loginOf, stored, presented, refreshers, checks, pc, held, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid

vars == <<issued, logins, loginOf, stored, presented, refreshers, checks, pc, held, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

NoPair == 0

NoRow == 0

MaxPairs == MaxLogins + MaxRefreshes

Pairs == 1..MaxPairs

Logins == 1..MaxLogins

Ends == {"live", "done", "lost"}

CheckRow == [checker : Checkers, opened : Pairs, refreshes : BOOLEAN, end : Ends]

Rows == DOMAIN checks

Live == {k \in Rows : checks[k].end = "live"}

Spent(p) == \E k \in Rows : checks[k].opened = p /\ checks[k].refreshes

Due(p) == ~\E k \in Rows : checks[k].opened = p /\ checks[k].end = "done"

Opened(c) == checks[row[c]].opened

Holds(c) == ~FinishNeedsClaim \/ checks[row[c]].end = "live"

ClaimIsOpen == ~ClaimIsExclusive \/ Live = {}

Claimable(c) == ClaimIsOpen /\ stored = held[c] /\ Due(held[c])

Refreshed == issued - logins

FileLogin(p) == p \in 1..issued /\ \A q \in 1..(p - 1) : loginOf[q] # loginOf[p]

Init ==
    /\ issued = 0
    /\ logins = 0
    /\ loginOf = [p \in Pairs |-> 0]
    /\ stored = NoPair
    /\ presented = [p \in Pairs |-> 0]
    /\ refreshers = {}
    /\ checks = <<>>
    /\ pc = [c \in Checkers |-> "idle"]
    /\ held = [c \in Checkers |-> NoPair]
    /\ row = [c \in Checkers |-> NoRow]
    /\ fresh = [c \in Checkers |-> NoPair]
    /\ crashes = 0
    /\ jobs = 0
    /\ jobCopy = NoPair
    /\ jobCanRefresh = FALSE
    /\ invalid = {}

PersonLogsIn ==
    /\ logins < MaxLogins
    /\ issued' = issued + 1
    /\ logins' = logins + 1
    /\ loginOf' = [loginOf EXCEPT ![issued + 1] = logins + 1]
    /\ stored' = issued + 1
    /\ UNCHANGED <<presented, refreshers, checks, pc, held, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

PersonReapplies ==
    /\ \E p \in 1..issued :
          /\ FileLogin(p)
          /\ p # stored
          /\ ~ReapplyNeedsNewerLogin \/ p > stored
          /\ stored' = p
    /\ UNCHANGED <<issued, logins, loginOf, presented, refreshers, checks, pc, held, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Open(c) ==
    /\ pc[c] = "idle"
    /\ stored # NoPair
    /\ Len(checks) < MaxChecks
    /\ Due(stored)
    /\ held' = [held EXCEPT ![c] = stored]
    /\ pc' = [pc EXCEPT ![c] = "opened"]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Claim(c) ==
    /\ pc[c] = "opened"
    /\ Len(checks) < MaxChecks
    /\ ClaimIsOpen
    /\ ~ClaimNeedsDueLogin \/ Claimable(c)
    /\ ~(RefreshIsClaimedOnce /\ Spent(held[c]))
    /\ checks' = Append(checks, [checker |-> c, opened |-> held[c], refreshes |-> TRUE, end |-> "live"])
    /\ row' = [row EXCEPT ![c] = Len(checks) + 1]
    /\ pc' = [pc EXCEPT ![c] = "claimed"]
    /\ held' = [held EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

RefuseSpentLogin(c) ==
    /\ pc[c] = "opened"
    /\ Claimable(c)
    /\ RefreshIsClaimedOnce
    /\ Spent(held[c])
    /\ invalid' = invalid \cup {loginOf[held[c]]}
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ held' = [held EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, row, fresh, crashes, jobs, jobCopy, jobCanRefresh>>

Skip(c) ==
    /\ pc[c] = "opened"
    /\ ~Claimable(c)
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ held' = [held EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Present(c) ==
    /\ pc[c] = "claimed"
    /\ Refreshed < MaxRefreshes
    /\ presented' = [presented EXCEPT ![Opened(c)] = @ + 1]
    /\ refreshers' = refreshers \cup {"engine"}
    /\ issued' = issued + 1
    /\ loginOf' = [loginOf EXCEPT ![issued + 1] = loginOf[Opened(c)]]
    /\ UNCHANGED <<logins, stored, checks, held, row, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Refresh(c) ==
    /\ Present(c)
    /\ fresh' = [fresh EXCEPT ![c] = issued + 1]
    /\ pc' = [pc EXCEPT ![c] = "refreshed"]

PresentThenDie(c) ==
    /\ Present(c)
    /\ pc' = [pc EXCEPT ![c] = "died"]
    /\ UNCHANGED fresh

Finish(c, refreshes, end) ==
    /\ checks' = [checks EXCEPT ![row[c]].refreshes = refreshes, ![row[c]].end = end]
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ row' = [row EXCEPT ![c] = NoRow]
    /\ fresh' = [fresh EXCEPT ![c] = NoPair]

NoRotation(c) ==
    /\ pc[c] = "claimed"
    /\ Holds(c)
    /\ Finish(c, FALSE, "done")
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, held, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

WriteBack(c) ==
    /\ pc[c] = "refreshed"
    /\ Holds(c)
    /\ stored' = IF ~WriteBackNeedsOpenedLogin \/ stored = Opened(c) THEN fresh[c] ELSE stored
    /\ Finish(c, TRUE, "done")
    /\ UNCHANGED <<issued, logins, loginOf, presented, refreshers, held, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

FinishDead(c) ==
    /\ pc[c] = "died"
    /\ Holds(c)
    /\ Finish(c, DeathKeepsRefreshClaim /\ checks[row[c]].refreshes, "lost")
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, held, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

FinishLate(c) ==
    /\ pc[c] \in {"claimed", "refreshed", "died"}
    /\ checks[row[c]].end # "live"
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ row' = [row EXCEPT ![c] = NoRow]
    /\ fresh' = [fresh EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, held, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Reap ==
    /\ \E k \in Live : checks' = [checks EXCEPT ![k].end = "lost"]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, pc, held, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Crash(c) ==
    /\ pc[c] # "idle"
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ held' = [held EXCEPT ![c] = NoPair]
    /\ row' = [row EXCEPT ![c] = NoRow]
    /\ fresh' = [fresh EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, jobs, jobCopy, jobCanRefresh, invalid>>

JobTakesCopy ==
    /\ jobs < MaxJobs
    /\ jobCopy = NoPair
    /\ stored # NoPair
    /\ jobs' = jobs + 1
    /\ jobCopy' = stored
    /\ jobCanRefresh' = ~JobCopyIsAccessOnly
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, pc, held, row, fresh, crashes, invalid>>

JobRuns ==
    /\ jobCopy # NoPair
    /\ jobCopy' = NoPair
    /\ jobCanRefresh' = FALSE
    /\ IF jobCanRefresh
          THEN /\ presented' = [presented EXCEPT ![jobCopy] = @ + 1]
               /\ refreshers' = refreshers \cup {"job"}
          ELSE UNCHANGED <<presented, refreshers>>
    /\ UNCHANGED <<issued, logins, loginOf, stored, checks, pc, held, row, fresh, crashes, jobs, invalid>>

Terminated == (\A c \in Checkers : pc[c] = "idle") /\ Live = {} /\ jobCopy = NoPair

Next ==
    \/ PersonLogsIn
    \/ PersonReapplies
    \/ \E c \in Checkers :
          \/ Open(c) \/ Claim(c) \/ RefuseSpentLogin(c) \/ Skip(c)
          \/ Refresh(c) \/ PresentThenDie(c)
          \/ NoRotation(c) \/ WriteBack(c) \/ FinishDead(c) \/ FinishLate(c)
          \/ Crash(c)
    \/ Reap
    \/ JobTakesCopy
    \/ JobRuns
    \/ Terminated /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ issued \in 0..MaxPairs
    /\ logins \in 0..MaxLogins
    /\ loginOf \in [Pairs -> 0..MaxLogins]
    /\ stored \in {NoPair} \cup Pairs
    /\ presented \in [Pairs -> Nat]
    /\ refreshers \subseteq {"engine", "job"}
    /\ checks \in Seq(CheckRow)
    /\ Len(checks) <= MaxChecks
    /\ pc \in [Checkers -> {"idle", "opened", "claimed", "refreshed", "died"}]
    /\ held \in [Checkers -> {NoPair} \cup Pairs]
    /\ row \in [Checkers -> {NoRow} \cup Rows]
    /\ fresh \in [Checkers -> {NoPair} \cup Pairs]
    /\ crashes \in 0..MaxCrashes
    /\ jobs \in 0..MaxJobs
    /\ jobCopy \in {NoPair} \cup Pairs
    /\ jobCanRefresh \in BOOLEAN
    /\ invalid \subseteq Logins

OneLiveCheck == Cardinality(Live) <= 1

NoRefreshTokenReused == \A p \in Pairs : presented[p] <= 1

JobsNeverRefresh == "job" \notin refreshers

OneCheckPerLogin == \A p \in Pairs : Cardinality({k \in Rows : checks[k].opened = p /\ checks[k].end = "done"}) <= 1

StoredLoginIsNewest == [][stored' > stored]_stored

FinishedCheckIsFinal == [][\A k \in Rows : checks[k].end # "live" => checks'[k] = checks[k]]_checks

=============================================================================

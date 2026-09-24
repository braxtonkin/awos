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
    JobCopyIsAccessOnly

ASSUME
    /\ Checkers # {}
    /\ MaxLogins \in Nat \ {0}
    /\ MaxRefreshes \in Nat
    /\ MaxChecks \in Nat
    /\ MaxCrashes \in Nat
    /\ MaxJobs \in Nat
    /\ {ClaimIsExclusive, RefreshIsClaimedOnce, WriteBackNeedsOpenedLogin, JobCopyIsAccessOnly} \subseteq BOOLEAN

VARIABLES issued, logins, loginOf, stored, presented, refreshers, checks, pc, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid

vars == <<issued, logins, loginOf, stored, presented, refreshers, checks, pc, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

NoPair == 0

NoRow == 0

MaxPairs == MaxLogins + MaxRefreshes

Pairs == 1..MaxPairs

Logins == 1..MaxLogins

CheckRow == [checker : Checkers, opened : Pairs, refreshes : BOOLEAN, live : BOOLEAN]

Rows == DOMAIN checks

Live == {k \in Rows : checks[k].live}

Spent(p) == \E k \in Rows : checks[k].opened = p /\ checks[k].refreshes

Opened(c) == checks[row[c]].opened

ClaimIsOpen == ~ClaimIsExclusive \/ Live = {}

Refreshed == issued - logins

Init ==
    /\ issued = 0
    /\ logins = 0
    /\ loginOf = [p \in Pairs |-> 0]
    /\ stored = NoPair
    /\ presented = [p \in Pairs |-> 0]
    /\ refreshers = {}
    /\ checks = <<>>
    /\ pc = [c \in Checkers |-> "idle"]
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
    /\ UNCHANGED <<presented, refreshers, checks, pc, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Claim(c) ==
    /\ pc[c] = "idle"
    /\ stored # NoPair
    /\ Len(checks) < MaxChecks
    /\ ClaimIsOpen
    /\ ~(RefreshIsClaimedOnce /\ Spent(stored))
    /\ checks' = Append(checks, [checker |-> c, opened |-> stored, refreshes |-> TRUE, live |-> TRUE])
    /\ row' = [row EXCEPT ![c] = Len(checks) + 1]
    /\ pc' = [pc EXCEPT ![c] = "claimed"]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

RefuseSpentLogin(c) ==
    /\ pc[c] = "idle"
    /\ stored # NoPair
    /\ ClaimIsOpen
    /\ RefreshIsClaimedOnce
    /\ Spent(stored)
    /\ invalid' = invalid \cup {loginOf[stored]}
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, pc, row, fresh, crashes, jobs, jobCopy, jobCanRefresh>>

Refresh(c) ==
    /\ pc[c] = "claimed"
    /\ Refreshed < MaxRefreshes
    /\ presented' = [presented EXCEPT ![Opened(c)] = @ + 1]
    /\ refreshers' = refreshers \cup {"engine"}
    /\ issued' = issued + 1
    /\ loginOf' = [loginOf EXCEPT ![issued + 1] = loginOf[Opened(c)]]
    /\ fresh' = [fresh EXCEPT ![c] = issued + 1]
    /\ pc' = [pc EXCEPT ![c] = "refreshed"]
    /\ UNCHANGED <<logins, stored, checks, row, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

NoRotation(c) ==
    /\ pc[c] = "claimed"
    /\ checks' = [checks EXCEPT ![row[c]].live = FALSE, ![row[c]].refreshes = FALSE]
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ row' = [row EXCEPT ![c] = NoRow]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

WriteBack(c) ==
    /\ pc[c] = "refreshed"
    /\ stored' = IF ~WriteBackNeedsOpenedLogin \/ stored = Opened(c) THEN fresh[c] ELSE stored
    /\ checks' = [checks EXCEPT ![row[c]].live = FALSE]
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ row' = [row EXCEPT ![c] = NoRow]
    /\ fresh' = [fresh EXCEPT ![c] = NoPair]
    /\ UNCHANGED <<issued, logins, loginOf, presented, refreshers, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Reap ==
    /\ \E k \in Live : checks' = [checks EXCEPT ![k].live = FALSE]
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, pc, row, fresh, crashes, jobs, jobCopy, jobCanRefresh, invalid>>

Crash(c) ==
    /\ pc[c] # "idle"
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = [pc EXCEPT ![c] = "idle"]
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
    /\ UNCHANGED <<issued, logins, loginOf, stored, presented, refreshers, checks, pc, row, fresh, crashes, invalid>>

JobRuns ==
    /\ jobCopy # NoPair
    /\ jobCopy' = NoPair
    /\ jobCanRefresh' = FALSE
    /\ IF jobCanRefresh
          THEN /\ presented' = [presented EXCEPT ![jobCopy] = @ + 1]
               /\ refreshers' = refreshers \cup {"job"}
          ELSE UNCHANGED <<presented, refreshers>>
    /\ UNCHANGED <<issued, logins, loginOf, stored, checks, pc, row, fresh, crashes, jobs, invalid>>

Terminated == (\A c \in Checkers : pc[c] = "idle") /\ Live = {} /\ jobCopy = NoPair

Next ==
    \/ PersonLogsIn
    \/ \E c \in Checkers : Claim(c) \/ RefuseSpentLogin(c) \/ Refresh(c) \/ NoRotation(c) \/ WriteBack(c) \/ Crash(c)
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
    /\ pc \in [Checkers -> {"idle", "claimed", "refreshed"}]
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

StoredLoginIsNewest == [][stored' > stored]_stored

=============================================================================

-------------------------------- MODULE Land --------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Checks,
    Ignorable,
    NoHead,
    QueueSettings,
    ReviewSettings,
    DraftSettings,
    LaterReviewSettings,
    MaxPushes,
    MaxReviews,
    MaxReruns,
    MaxEjections,
    MaxCallFailures,
    ActionCarriesHead,
    ReadyWaitsForGreen,
    RedCheckSendsBack,
    ConflictSendsBack,
    EjectionEndsAttempt,
    LandPollIsFair,
    LandWaitsForMergeRow,
    LandWaitsWhileQueued,
    FailedMergeKeepsClaim,
    MergeClaimChecksTask,
    RefusalFailsAttempt,
    AnyReviewResumesLand

ASSUME Ignorable # {} /\ Ignorable \subseteq Checks /\ Checks \ Ignorable # {} /\ NoHead \notin Nat

ASSUME QueueSettings \subseteq BOOLEAN /\ ReviewSettings \subseteq BOOLEAN

ASSUME DraftSettings \subseteq {"whenGreen", "atOnce"} /\ LaterReviewSettings \subseteq {"wait", "ignore"}

ASSUME \A bound \in {MaxPushes, MaxReviews, MaxReruns, MaxEjections, MaxCallFailures} : bound \in Nat

VARIABLES
    repo,
    head, check, draft, conflict, reviews, lastReview, queue, mergedAt,
    task, landFails, reviewReturned, seen, ejectionAnswered, refusedAt,
    row, rowHead, inflight,
    ejections, reruns, failures,
    judged

pr == <<head, check, draft, conflict, reviews, lastReview, queue, mergedAt>>

engine == <<task, landFails, reviewReturned, seen, ejectionAnswered, refusedAt>>

outbox == <<row, rowHead, inflight>>

budgets == <<ejections, reruns, failures>>

vars == <<repo, pr, engine, outbox, budgets, judged>>

Heads == 0..MaxPushes

Counted == Checks \ Ignorable

RequiredSettings == {{c} : c \in Checks}

LandRetries == 2

Settled == {"done", "waiting", "stopped"}

TypeOK ==
    /\ repo \in [queue : BOOLEAN, reviews : BOOLEAN, draft : {"whenGreen", "atOnce"}, later : {"wait", "ignore"}, required : RequiredSettings]
    /\ head \in Heads
    /\ check \in [Checks -> {"pending", "green", "red"}]
    /\ draft \in BOOLEAN
    /\ conflict \in BOOLEAN
    /\ reviews \in 0..MaxReviews
    /\ lastReview \in {"none", "approve", "changes"}
    /\ queue \in {"none", "queued", "ejected"}
    /\ mergedAt \in Heads \cup {NoHead}
    /\ task \in {"land", "implement", "awaiting"} \cup Settled
    /\ landFails \in 0..(LandRetries + 1)
    /\ reviewReturned \in BOOLEAN
    /\ seen \in 0..MaxReviews
    /\ ejectionAnswered \in BOOLEAN
    /\ refusedAt \in Heads \cup {NoHead}
    /\ row \in {"none", "owed", "claimed"}
    /\ rowHead \in Heads \cup {NoHead}
    /\ inflight \in Heads \cup {NoHead}
    /\ ejections \in 0..MaxEjections
    /\ reruns \in 0..MaxReruns
    /\ failures \in 0..MaxCallFailures
    /\ judged \subseteq Heads

Init ==
    /\ repo \in [queue : QueueSettings, reviews : ReviewSettings, draft : DraftSettings, later : LaterReviewSettings, required : RequiredSettings]
    /\ head = 0
    /\ check = [c \in Checks |-> "pending"]
    /\ draft = TRUE
    /\ conflict = FALSE
    /\ reviews = 0
    /\ lastReview = "none"
    /\ queue = "none"
    /\ mergedAt = NoHead
    /\ task = "land"
    /\ landFails = 0
    /\ reviewReturned = FALSE
    /\ seen = 0
    /\ ejectionAnswered = FALSE
    /\ refusedAt = NoHead
    /\ row = "none"
    /\ rowHead = NoHead
    /\ inflight = NoHead
    /\ ejections = 0
    /\ reruns = 0
    /\ failures = 0
    /\ judged = {}

Red == \E c \in Counted : check[c] = "red"

Pending == \E c \in Counted : check[c] = "pending"

AllGreen == \A c \in Counted : check[c] = "green"

ReviewSatisfied == ~repo.reviews \/ lastReview = "approve"

NewChangesRequested == lastReview = "changes" /\ reviews > seen

UnansweredEjection == queue = "ejected" /\ ~ejectionAnswered

Allows(h) ==
    /\ head = h
    /\ ~draft
    /\ ~conflict
    /\ \A c \in repo.required : check[c] = "green"
    /\ ReviewSatisfied

MergeOnItsWay == (LandWaitsForMergeRow /\ row # "none") \/ (LandWaitsWhileQueued /\ queue = "queued")

Decision ==
    IF mergedAt # NoHead THEN "complete"
    ELSE IF EjectionEndsAttempt /\ UnansweredEjection THEN "failAttempt"
    ELSE IF ConflictSendsBack /\ conflict THEN "sendBack"
    ELSE IF draft /\ repo.draft = "atOnce" THEN "markReady"
    ELSE IF Red /\ repo.draft = "atOnce" THEN "failAttempt"
    ELSE IF Red /\ RedCheckSendsBack THEN "sendBack"
    ELSE IF draft /\ (ReadyWaitsForGreen => AllGreen) THEN "markReady"
    ELSE IF Pending \/ draft THEN "waitForChecks"
    ELSE IF NewChangesRequested THEN "answerReview"
    ELSE IF ~ReviewSatisfied THEN "awaitApproval"
    ELSE IF RefusalFailsAttempt /\ refusedAt = head THEN "failAttempt"
    ELSE "oweMerge"

Decides(d) ==
    /\ task = "land"
    /\ ~MergeOnItsWay
    /\ Decision = d

BackToImplement ==
    /\ task' = "implement"
    /\ landFails' = 0

Complete ==
    /\ Decides("complete")
    /\ task' = "done"
    /\ UNCHANGED <<repo, pr, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

FailAttempt ==
    /\ Decides("failAttempt")
    /\ landFails' = landFails + 1
    /\ task' = IF landFails + 1 > LandRetries THEN "waiting" ELSE "land"
    /\ ejectionAnswered' = (ejectionAnswered \/ queue = "ejected")
    /\ refusedAt' = NoHead
    /\ UNCHANGED <<repo, pr, reviewReturned, seen, outbox, budgets, judged>>

SendBack ==
    /\ Decides("sendBack")
    /\ BackToImplement
    /\ UNCHANGED <<repo, pr, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

MarkReady ==
    /\ Decides("markReady")
    /\ draft' = FALSE
    /\ UNCHANGED <<repo, head, check, conflict, reviews, lastReview, queue, mergedAt, engine, outbox, budgets, judged>>

AnswerReview ==
    /\ Decides("answerReview")
    /\ seen' = reviews
    /\ IF reviewReturned
       THEN /\ task' = IF repo.later = "wait" THEN "waiting" ELSE "land"
            /\ UNCHANGED <<landFails, reviewReturned>>
       ELSE /\ BackToImplement
            /\ reviewReturned' = TRUE
    /\ UNCHANGED <<repo, pr, ejectionAnswered, refusedAt, outbox, budgets, judged>>

AwaitApproval ==
    /\ Decides("awaitApproval")
    /\ task' = "awaiting"
    /\ UNCHANGED <<repo, pr, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

OweMerge ==
    /\ Decides("oweMerge")
    /\ row = "none"
    /\ row' = "owed"
    /\ rowHead' = head
    /\ judged' = judged \cup {head}
    /\ UNCHANGED <<repo, pr, engine, inflight, budgets>>

Resume ==
    /\ task = "awaiting"
    /\ ReviewSatisfied \/ (AnyReviewResumesLand /\ NewChangesRequested)
    /\ task' = "land"
    /\ UNCHANGED <<repo, pr, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

LandPoll == Complete \/ FailAttempt \/ SendBack \/ MarkReady \/ AnswerReview \/ AwaitApproval \/ OweMerge \/ Resume

Named(h) == IF ActionCarriesHead THEN h ELSE head

AlreadyOnGitHub == mergedAt # NoHead \/ queue = "queued" \/ (EjectionEndsAttempt /\ UnansweredEjection)

Refuses(h) == ~AlreadyOnGitHub /\ ~Allows(h)

MergeAt(h) ==
    IF AlreadyOnGitHub \/ ~Allows(h)
    THEN UNCHANGED <<queue, mergedAt, ejectionAnswered>>
    ELSE IF repo.queue
         THEN /\ queue' = "queued"
              /\ ejectionAnswered' = FALSE
              /\ UNCHANGED mergedAt
         ELSE /\ mergedAt' = h
              /\ UNCHANGED <<queue, ejectionAnswered>>

Withdraws == MergeClaimChecksTask /\ task # "land"

Perform ==
    /\ row = "owed"
    /\ IF Withdraws
       THEN /\ row' = "none"
            /\ rowHead' = NoHead
            /\ UNCHANGED <<repo, pr, engine, inflight, budgets, judged>>
       ELSE \/ /\ MergeAt(Named(rowHead))
               /\ refusedAt' = IF Refuses(Named(rowHead)) THEN rowHead ELSE refusedAt
               /\ row' = "none"
               /\ rowHead' = NoHead
               /\ UNCHANGED <<repo, head, check, draft, conflict, reviews, lastReview, task, landFails, reviewReturned, seen, inflight, budgets, judged>>
            \/ /\ failures < MaxCallFailures
               /\ failures' = failures + 1
               /\ inflight' = rowHead
               /\ row' = IF FailedMergeKeepsClaim THEN "claimed" ELSE "owed"
               /\ UNCHANGED <<repo, pr, engine, rowHead, ejections, reruns, judged>>

Arrive ==
    /\ inflight # NoHead
    /\ MergeAt(Named(inflight))
    /\ inflight' = NoHead
    /\ UNCHANGED <<repo, head, check, draft, conflict, reviews, lastReview, task, landFails, reviewReturned, seen, refusedAt, row, rowHead, budgets, judged>>

Vanish ==
    /\ inflight # NoHead
    /\ inflight' = NoHead
    /\ UNCHANGED <<repo, pr, engine, row, rowHead, budgets, judged>>

Lapse ==
    /\ row = "claimed"
    /\ inflight = NoHead
    /\ row' = "owed"
    /\ UNCHANGED <<repo, pr, engine, rowHead, inflight, budgets, judged>>

QueueMerges ==
    /\ queue = "queued"
    /\ Allows(head)
    /\ mergedAt' = head
    /\ queue' = "none"
    /\ UNCHANGED <<repo, head, check, draft, conflict, reviews, lastReview, engine, outbox, budgets, judged>>

QueueEjects ==
    /\ queue = "queued"
    /\ IF Allows(head)
       THEN /\ ejections < MaxEjections
            /\ ejections' = ejections + 1
       ELSE UNCHANGED ejections
    /\ queue' = "ejected"
    /\ UNCHANGED <<repo, head, check, draft, conflict, reviews, lastReview, mergedAt, engine, outbox, reruns, failures, judged>>

NewHead ==
    /\ mergedAt = NoHead
    /\ head < MaxPushes
    /\ head' = head + 1
    /\ check' = [c \in Checks |-> "pending"]
    /\ conflict' = FALSE
    /\ queue' = IF queue = "queued" THEN "ejected" ELSE queue

Implement ==
    /\ task = "implement"
    /\ \/ /\ NewHead
          /\ task' = "land"
          /\ UNCHANGED <<repo, draft, reviews, lastReview, mergedAt, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>
       \/ /\ task' = "waiting"
          /\ UNCHANGED <<repo, pr, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

OutsidePush ==
    /\ task = "land"
    /\ NewHead
    /\ UNCHANGED <<repo, draft, reviews, lastReview, mergedAt, engine, outbox, budgets, judged>>

BaseConflicts ==
    /\ task = "land"
    /\ mergedAt = NoHead
    /\ ~conflict
    /\ conflict' = TRUE
    /\ UNCHANGED <<repo, head, check, draft, reviews, lastReview, queue, mergedAt, engine, outbox, budgets, judged>>

Stop ==
    /\ task = "land"
    /\ row # "none" \/ inflight # NoHead \/ queue = "queued"
    /\ task' = "stopped"
    /\ UNCHANGED <<repo, pr, landFails, reviewReturned, seen, ejectionAnswered, refusedAt, outbox, budgets, judged>>

Finish(c) ==
    /\ task \in {"land", "awaiting"}
    /\ mergedAt = NoHead
    /\ check[c] = "pending"
    /\ c \in Counted \cup repo.required
    /\ \E result \in {"green", "red"} : check' = [check EXCEPT ![c] = result]
    /\ UNCHANGED <<repo, head, draft, conflict, reviews, lastReview, queue, mergedAt, engine, outbox, budgets, judged>>

Rerun(c) ==
    /\ task = "land"
    /\ mergedAt = NoHead
    /\ row # "none" \/ inflight # NoHead \/ queue = "queued"
    /\ c \in Counted
    /\ check[c] # "pending"
    /\ reruns < MaxReruns
    /\ check' = [check EXCEPT ![c] = "pending"]
    /\ reruns' = reruns + 1
    /\ UNCHANGED <<repo, head, draft, conflict, reviews, lastReview, queue, mergedAt, engine, outbox, ejections, failures, judged>>

Review(kind) ==
    /\ task \in {"land", "awaiting"}
    /\ mergedAt = NoHead
    /\ ~draft
    /\ reviews < MaxReviews
    /\ kind = "approve" => repo.reviews
    /\ reviews' = reviews + 1
    /\ lastReview' = kind
    /\ UNCHANGED <<repo, head, check, draft, conflict, queue, mergedAt, engine, outbox, budgets, judged>>

Next ==
    \/ LandPoll
    \/ Perform \/ Arrive \/ Vanish \/ Lapse
    \/ QueueMerges \/ QueueEjects
    \/ Implement \/ OutsidePush \/ BaseConflicts \/ Stop
    \/ \E c \in Checks : Finish(c) \/ Rerun(c)
    \/ \E kind \in {"approve", "changes"} : Review(kind)
    \/ task \in Settled \cup {"awaiting"} /\ UNCHANGED vars

OutsideProgress ==
    /\ WF_vars(Perform)
    /\ WF_vars(Arrive \/ Vanish)
    /\ WF_vars(Lapse)
    /\ WF_vars(QueueMerges \/ QueueEjects)
    /\ WF_vars(\E c \in Checks : Finish(c))
    /\ WF_vars(Implement)

Spec == Init /\ [][Next]_vars /\ OutsideProgress /\ (IF LandPollIsFair THEN WF_vars(LandPoll) ELSE TRUE)

MergedHeadWasMergeable == mergedAt # NoHead => mergedAt \in judged

Merges == (mergedAt = NoHead /\ mergedAt' # NoHead) \/ (queue # "queued" /\ queue' = "queued")

SentBeforeStop == inflight # NoHead \/ queue = "queued"

PerformedMergeWasAllowed == [][Merges => task = "land" \/ (task = "stopped" /\ SentBeforeStop)]_vars

ReadyOnlyWhenChecksGreen == [][draft /\ ~draft' => repo.draft = "atOnce" \/ AllGreen]_vars

LandDecides == task = "land" /\ mergedAt = NoHead /\ LandPoll

EjectionFailsLand ==
    [][/\ LandDecides /\ UnansweredEjection => landFails' = landFails + 1
       /\ queue = "ejected" /\ queue' = "queued" => ejectionAnswered]_vars

ConflictReturnsToImplement == [][LandDecides /\ ~UnansweredEjection /\ conflict => task' \in {"implement", "waiting"}]_vars

RedCheckReturnsToImplement ==
    [][LandDecides /\ ~UnansweredEjection /\ ~conflict /\ repo.draft = "whenGreen" /\ Red => task' \in {"implement", "waiting"}]_vars

LandSettles == <>[](task \in Settled \/ (task = "awaiting" /\ ~NewChangesRequested))

=============================================================================

# Decisions

Record decisions that affect scope, behavior, data, permissions, integrations, environments, or delivery. Do not rewrite history; append superseding decisions.

## 2026-10-28 — Restrict After Sales notifications to missed transfers

- Status: approved
- Decision: After Sales receives notifications only for Sales-to-After-Sales queue transfers that finish unanswered. Do not route After Sales notifications using the caller's historical last-contacted agent, and do not include the old fallback sentence or `Last Contacted` field.
- Source or approver: Joseph, relayed by the user
- Context: The existing notification can classify an unrelated agentless call as After Sales because the caller previously spoke with an After Sales agent.
- Alternatives considered: Keep both notification types; suppress only the old explanatory text.
- Rationale: Joseph wants only missed transferred queue calls represented in After Sales.
- Consequences: After Sales routing must be based on verified CallFlow queue and agent-offer events, while other teams retain existing behavior unless separately changed.
- Supersedes: Historical last-contacted routing for After Sales.

## 2026-10-28 — Show duration only for the final agent offer

- Status: approved
- Decision: List all agents actually rung in chronological order. Show actual ring seconds only for the final offer; omit durations for earlier offers.
- Source or approver: Joseph, relayed by the user
- Context: Earlier agent timeouts are configured as 30 seconds, while the final attempt may end early.
- Alternatives considered: Show every measured duration; derive the final duration from total call time.
- Rationale: The requested card is concise and the final duration must reflect the actual offer interval.
- Consequences: The implementation must pair Ziwo offer-start and offer-end timestamps and must not reuse the call-level `ringTime`.
- Supersedes:

## 2026-10-28 — Include queue and direct-agent transfers

- Status: approved
- Decision: Both Sales-to-After-Sales queue transfers and direct Sales-to-After-Sales-agent transfers qualify when the After Sales attempt finishes unanswered.
- Source or approver: User clarification
- Context: The inspected example call transferred directly to Aya Othman rather than entering an After Sales queue.
- Alternatives considered: Limit notifications to queue transfers only.
- Rationale: Both transfer methods represent missed After Sales calls for the requested workflow.
- Consequences: CallFlow classification must support both queue agent-offer stages and direct `transfer`/`offering-start` stages while excluding unrelated direct calls.
- Supersedes: Queue-only interpretation of the 2026-10-28 After Sales decision.

## 2026-10-28 — Notify only when nobody answers and preserve every attempt

- Status: approved
- Decision: Send the After Sales notification only if nobody in After Sales ultimately answers. List every ringing attempt chronologically, including the same agent again when retried, and show ringing duration only beside the final attempt.
- Source or approver: Joseph, relayed by the user
- Context: Needed one consistent rule across queue transfers and direct-agent transfers.
- Alternatives considered: Notify for intermediate misses even when someone later answers; deduplicate repeated agents.
- Rationale: The notification should represent the complete unsuccessful After Sales handoff.
- Consequences: The interpreter must evaluate terminal outcome, preserve ordered attempts, and deduplicate notifications by transfer/queue visit rather than by agent.
- Supersedes:

## 2026-10-28 — Apply transfer-only notifications to CMR

- Status: approved
- Decision: Apply the same queue/direct transfer rules, ordered attempts, ultimate-answer suppression, and final-attempt-only duration to CMR. Disable legacy current-agent and historical-agent CMR notifications.
- Source or approver: User
- Context: CMR uses queue `9` and Ziwo accounts `107`/`108` and should follow the After Sales notification model.
- Alternatives considered: Preserve the existing CMR canceled-call fallback.
- Rationale: The user explicitly requested identical behavior for CMR.
- Consequences: Transfer interpretation and card construction are destination-parameterized; team delivery and duplicate keys remain isolated. Presales is the only team retaining the legacy fallback.
- Supersedes: The earlier assumption that CMR behavior remains unchanged.

## 2026-10-28 — Ignore stale agent rows

- Status: approved
- Decision: A spreadsheet agent grants team membership only when the same numeric ID exists in Ziwo's current `deleted=false` agent directory.
- Source or approver: User request to disregard Rahaf
- Context: Rahaf ID `124` exists in the sheet but not in the current Ziwo response.
- Alternatives considered: Hardcode Rahaf's name or ID exclusion.
- Rationale: Intersecting the two authoritative sources handles all stale rows consistently.
- Consequences: Stale rows cannot qualify direct transfers or establish a Sales source; no name-specific exclusion is required.
- Supersedes:

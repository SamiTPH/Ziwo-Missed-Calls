# Project State

## Objective

Send After Sales and CMR missed-call notifications only for unanswered Sales transfers to their queues or agents, listing the agents rung in order and showing actual ring seconds only for the final attempt.

## Scope

### Included

- Remove the historical "last contacted" fallback from After Sales notifications.
- Detect After Sales queue visits and direct After Sales agent transfers from Ziwo CallFlow data.
- List actual agent offers chronologically and suppress the card if an After Sales agent answers.
- Apply the same transfer-only behavior to CMR queue `9` and active CMR agents.
- Preserve existing behavior for Presales.

### Excluded

- Changing Ziwo queue timeout configuration.
- Call History v2 migration.
- Production deployment until separately approved.

## Environment

- Repository: `SamiTPH/Ziwo-Missed-Calls`
- Branch: `main`
- Local/staging/production target: local analysis and implementation first; production is approval-gated
- External systems: Ziwo API, Microsoft Graph/Excel, Microsoft Teams Workflows
- Package manager: npm

## Current phase

- Phase: local implementation and tenant preview validation
- Status: ready for review
- Last verified: 2026-10-28

## Completed

- Confirmed Ziwo CallFlow exposes queue and per-agent offer events.
- Confirmed legacy After Sales routing can originate from caller-history fallback and must be excluded.
- Inspected call `8779e00a-f8d8-4ce0-b0e4-87740c704f59` read-only: the Sales queue visit was answered, then the call was transferred directly to agent extension `0042` (Aya Othman) for about 30 seconds; no After Sales queue visit was present.
- Confirmed with the user that both destination queue transfers and direct After Sales agent transfers qualify.
- Identified Ziwo After Sales queue `8` (`TPH_After_Sales_Queue`) from the supplied agent response.
- Joseph confirmed notification eligibility, chronological attempt ordering, repeated-attempt handling, and final-attempt-only duration on 2026-10-28.
- Implemented the pure CallFlow interpreter, After Sales card, bounded CallFlow retries, legacy After Sales suppression, and process-local duplicate-send protection.
- Replayed the supplied direct-transfer call read-only: one missed Aya Othman attempt with 30 seconds; no Teams message sent.
- Local suite passes 24 tests; independent verification and final code review report no actionable findings after the CMR generalization.
- Generalized the interpreter/card/delivery path for CMR and added active-agent filtering so stale Rahaf ID `124` is ignored.
- Added CMR IDs `107` and `108` to the live configured Excel table with explicit user authorization; verified range expanded from `Sheet1!A1:C31` to `Sheet1!A1:C33`.

## Pending

- Validate a representative unanswered transfer and answered transfer against the tenant.
- Validate an actual missed and answered queue-8 transfer.
- Validate a successful direct transfer's event semantics.
- Validate a real queue-9 or direct CMR transfer after the sheet cache refreshes.
- Prepare `LIVE_CHANGE_PLAN.md` and obtain explicit approval before production rollout.

## Blockers and required decisions

- A representative queue-transfer call remains desirable for tenant-level parity verification.
- Confirm behavior for zero offers, multiple queue visits, and missing final timing during implementation review.
- Real queue-9/direct-CMR CallFlow evidence is still required before production code rollout.

## Evidence

- Tests: 19 local tests passed on 2026-10-28; syntax, import, and diff checks passed
- Review: independent test verification and findings-first code review completed; no actionable findings remain
- Deployment or live-system verification: sanitized read-only CDR and CallFlow inspection completed for one direct-transfer call; no mutation or Teams message

## Next action

- Run preview-only validation against real queue-8 missed/answered examples, then prepare the production change plan.

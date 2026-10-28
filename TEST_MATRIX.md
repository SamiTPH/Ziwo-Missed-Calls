# Test Matrix

| ID | Requirement or risk | Verification method | Environment | Expected result | Evidence | Status |
|---|---|---|---|---|---|---|
| AC-01 | Historical last-contacted After Sales call | Guard inspection | Local | No After Sales notification | Legacy After Sales dispatch is blocked | Passed |
| AC-02 | Sales transfers; Sami, Aya, Joseph miss; Joseph rings 5 seconds | CallFlow fixture test | Local | One card lists all three in order; only Joseph shows 5 seconds | Ordered/repeated queue attempt tests pass | Passed |
| AC-03 | An After Sales agent eventually answers | CallFlow fixture test | Local | No missed-call card | Queue/direct/mixed answer tests pass | Passed |
| AC-04 | Overall CDR is answered because Sales answered | Fixture and sanitized replay | Local/read-only tenant | Unanswered After Sales handoff remains eligible | Supplied answered CDR reconstructed as missed direct transfer | Passed |
| AC-05 | Direct non-transfer After Sales offer | CallFlow fixture test | Local | No notification | Direct-entry rejection test passes | Passed |
| AC-06 | Duplicate/replayed processing | Code review | Local | One card per missed handoff within one process | In-flight and delivered keys reviewed; restart persistence untested | Passed |
| AC-07 | Presales regression | Code inspection | Local | Existing routing remains unchanged | Existing branch retained; live delivery untested | Passed |
| AC-08 | Missing final offer end timestamp | CallFlow fixture test | Local | No fabricated duration or send | Incomplete and retry tests pass | Passed |
| AC-09 | Sales transfers directly to an After Sales agent who does not answer | Fixture and sanitized replay | Local/read-only tenant | One After Sales card lists that agent with actual final ring seconds | Aya reconstructed at 30 seconds; no message sent | Passed |
| AC-10 | Sales transfers to CMR queue and nobody answers | CallFlow fixture test | Local | One CMR card lists attempts in order and only final duration | Queue-9 interpreter and CMR card tests pass | Passed |
| AC-11 | CMR or After Sales agent ultimately answers | Destination-isolation fixture test | Local | Answer suppresses only the relevant destination notification | Team-isolation tests pass | Passed |
| AC-12 | Stale Rahaf sheet row | Active-membership test | Local | Rahaf is excluded without hardcoding | Active-directory intersection test passes | Passed |
| AC-13 | One team webhook fails when both teams have missed handoffs | Delivery isolation test | Local | Other team delivery is still attempted | After Sales failure/CMR success regression passes | Passed |
| AC-14 | CMR active IDs exist inside configured Excel table | Graph read-back | Live workbook | IDs 107/108 each appear once in `AgentsTable` | 32 rows; range `Sheet1!A1:C33`; both values verified | Passed |

## Status values

- Not run
- Passed
- Failed
- Blocked
- Not applicable

## Open coverage gaps

- Actual missed/answered queue-8/queue-9 timelines, successful direct-transfer semantics, CallFlow persistence timing, and live Teams delivery remain unverified.
- Duplicate protection is process-local and does not survive restarts.

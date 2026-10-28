# Live Change Plan

## Authorization

- User-approved objective: Add the two active CMR Ziwo accounts to the configured agent/team Excel table.
- Approved target: `/Ziwo Agents.xlsx`, table `AgentsTable`.
- Approval date/time: 2026-10-28, Asia/Damascus.

## Exact target

- System and tenant/workspace: Microsoft Graph workbook owned by `sp.admin@tphgroup.me`.
- Environment: live shared workbook.
- Workflow/resource/data range: `Sheet1`, table columns `Team | AgentName | ID`.

## Current-state evidence

- Before execution the table range was `Sheet1!A1:C31` with 30 data rows.
- IDs `107` and `108` were absent immediately before insertion.

## Proposed delta

- Append `CMR Team | CMR Ziwo1 | 107`.
- Append `CMR Team | CMR Ziwo2 | 108`.

## Impact and risks

- Data impact: two rows appended; no existing rows changed.
- User impact: direct transfers to active CMR agents can qualify after the script refreshes its sheet cache.
- Message/API cost impact: one Graph write plus verification reads; no Teams message sent.
- Permission or security impact: existing Graph application credentials used; no permission changes.
- Failure modes: duplicate rows, wrong table, or values outside the table; all were checked after execution.

## Execution steps

1. Re-read headers and IDs.
2. Append only missing IDs in one table-row request.
3. Re-read rows and table range.

## Rollback or recovery

1. Locate rows whose complete values match the two appended CMR records.
2. Delete only those rows and verify the table returns to its prior contents.

## Verification

1. Confirm IDs `107` and `108` each appear once with the requested team/name.
2. Confirm data-row count is 32 and table range is `Sheet1!A1:C33`.

## Result

- Status: completed
- Evidence: two rows added; before count 30, after count 32; verified values and range `Sheet1!A1:C33`.
- Follow-up: allow up to 900 seconds for the running notifier's sheet cache to refresh.

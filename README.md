# Ziwo Missed Call Notifier

This script listens for live Ziwo call-history events and sends missed-call notifications to the correct Microsoft Teams Workflow webhook.

Presales routing uses the agent ID from the agents/teams Excel sheet. After Sales and CMR notifications use verified Ziwo CallFlow transfers to their configured queues or agents.

## What It Does

1. Logs in to the Ziwo API using `ZIWO_USERNAME` and `ZIWO_PASSWORD`.
2. Connects to the Ziwo socket endpoint and subscribes to `GET /callHistory`.
3. When Ziwo emits a new call-history event, fetches the full CDR by `callID`.
4. Reads the call's Ziwo CallFlow to find unanswered Sales transfers to After Sales or CMR.
5. Otherwise checks whether the call is an inbound canceled call for the existing Presales flow.
6. Looks up agent IDs in the agents/teams Excel sheet.
7. Sends a Microsoft Teams Workflow notification to the appropriate team webhook.

If a missed call did not reach an agent, the script looks up the caller's previous call history:

```text
GET /callHistory/?contactNumber=<caller number>&limit=20&skip=0
```

It then finds the latest previous call that had an agent, looks up that agent ID in the sheet, and routes the notification to that agent's team. This historical fallback is disabled for After Sales and CMR.

For Presales fallback notifications, the card includes:

```text
Call didn't reach queue / agent, client last contacted <agent name>
```

## How Routing Works

The routing source of truth is the Excel agent/team sheet.

The script reads the sheet through Microsoft Graph and builds a lookup by agent ID. The agent ID from the Ziwo CDR must match the ID column in the sheet.

Supported team values are normalized to:

```text
after_sales
presales
cmr
```

Examples of accepted sheet team values:

```text
After Sales
After Sales Team
Presales
Pre Sales
CMR
CMR Team
```

After Sales and CMR are stricter: a legacy current-agent or historical-agent match cannot send to their webhooks. The call must contain a verified Sales transfer to the destination queue or agent, and nobody in that destination team may have answered.

## Required Environment Variables

Create a `.env` file using `.env.example` as the template.

### Ziwo

```text
ZIWO_INSTANCE=
ZIWO_USERNAME=
ZIWO_PASSWORD=
ZIWO_CANCEL_RESULTS=cancel
ZIWO_DISPLAY_TIMEZONE=Asia/Dubai
ZIWO_AGENT_CACHE_TTL_SECONDS=900
AFTER_SALES_QUEUE_IDS=8
CMR_QUEUE_IDS=9
TRANSFER_CALLFLOW_RETRY_DELAYS_MS=1000,3000
```

`ZIWO_INSTANCE` can be either the full API URL or the instance prefix. For example, both of these are valid:

```text
https://tphgroup-api.aswat.co
tphgroup
```

### Microsoft Graph

These credentials are used to read the Excel table that maps agents to teams.

```text
MS_GRAPH_TENANT_ID=
MS_GRAPH_CLIENT_ID=
MS_GRAPH_CLIENT_SECRET=
```

The Graph app registration must have permission to read the workbook file.

### Agent/Team Sheet

```text
AGENT_SHEET_EXCEL_USER=
AGENT_SHEET_FILE_PATH=
AGENT_SHEET_TABLE_NAME=
AGENT_SHEET_ID_COLUMN=
AGENT_SHEET_NAME_COLUMN=
AGENT_SHEET_TEAM_COLUMN=
AGENT_SHEET_CACHE_TTL_SECONDS=900
```

The sheet must contain a team column and an agent ID column. Agent name is useful for readability, but notification routing is based on agent ID.

Example file path:

```text
/Shared Documents/Agents.xlsx
```

### Teams Workflow Webhooks

Each team needs its own Microsoft Teams Workflow or Power Automate webhook URL:

```text
TEAMS_WEBHOOK_URL_AFTER_SALES=
TEAMS_WEBHOOK_URL_PRESALES=
TEAMS_WEBHOOK_URL_CMR=
```

## Running The Script

Install dependencies:

```powershell
npm install
```

Start the listener:

```powershell
npm start
```

The script keeps running and waits for live Ziwo socket events.

## Main API Calls

Fetch one CDR by call ID:

```text
GET /callHistory/?callID=<callID>&limit=1&skip=0
```

Fetch caller history for no-agent missed calls:

```text
GET /callHistory/?contactNumber=<caller number>&limit=20&skip=0
```

Fetch Ziwo agents for agent ID to display-name fallback:

```text
GET /callHistory/listAgents?deleted=false
```

Fetch CallFlow stages and nested multi-agent offers:

```text
GET /callHistory/<callID>/callflow?limit=100&skip=0
GET /callHistory/<callID>/callflow?limit=100&skip=0&parentId=<stage id>
```

All Ziwo API calls use:

```text
access_token: <Ziwo access token>
```

## Notification Contents

Presales cards include:

The Teams card includes:

- Time started
- Time ended
- Ring time, using Ziwo's `ringTime` CDR value (seconds)
- Caller number
- Agent, or `call didn't reach an agent`
- Last contacted agent, when fallback history was used
- Team

After Sales and CMR transfer cards include:

- Time started
- Time ended
- Caller number
- Every actual agent ring attempt in chronological order
- Actual ring seconds beside the final attempt only
- Team

After Sales and CMR transfer cards do not contain the historical `Last Contacted` field or the call-level `ringTime`.

## Skip Conditions

The script skips sending a Teams message when:

- The call is not an inbound canceled call.
- The call has no agent and no previous call with an agent was found.
- The agent ID cannot be matched to a team in the sheet.
- No webhook URL is configured for the matched team.
- An After Sales or CMR route came only from current/historical agent matching rather than a verified Sales transfer.
- An agent in the destination team ultimately answered the transfer.
- Transfer CallFlow evidence is incomplete.

## Verification

To check JavaScript syntax without starting the listener:

```powershell
node --check .\index.js
```

Run the local tests without starting the listener:

```powershell
npm test
```

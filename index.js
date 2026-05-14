require('dotenv').config()

const axios = require('axios')
const io = require('socket.io-client')

const appVersion = 'teams-workflow-team-routing-v6'
const graphBaseUrl = 'https://graph.microsoft.com/v1.0'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function getBaseUrl(instanceOrUrl) {
  const value = instanceOrUrl.trim().replace(/\/+$/, '')

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (/-api\.aswat\.co$/i.test(value)) {
    return `https://${value}`
  }

  return `https://${value}-api.aswat.co`
}

function getErrorMessage(error) {
  if (error.response) {
    return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
  }

  if (error.request) {
    return error.code
      ? `Request failed before response: ${error.code}`
      : 'Request failed before response'
  }

  return error.message
}

const baseUrl = getBaseUrl(requireEnv('ZIWO_INSTANCE'))
const cancelResults = (process.env.ZIWO_CANCEL_RESULTS || 'cancel')
  .split(',')
  .map((result) => result.trim())
  .filter(Boolean)
const displayTimeZone = process.env.ZIWO_DISPLAY_TIMEZONE || 'Asia/Dubai'
const dateTimeFormatter = new Intl.DateTimeFormat('en-AE', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
  timeZone: displayTimeZone,
})
const teamsWebhookUrlsByTeam = new Map([
  ['after_sales', process.env.TEAMS_WEBHOOK_URL_AFTER_SALES],
  ['presales', process.env.TEAMS_WEBHOOK_URL_PRESALES],
  ['cmr', process.env.TEAMS_WEBHOOK_URL_CMR],
].filter(([, url]) => Boolean(url)))
const agentCacheTtlMs = Number(process.env.ZIWO_AGENT_CACHE_TTL_SECONDS || 900) * 1000
const agentDirectory = {
  agentsById: new Map(),
  expiresAt: 0,
  refreshPromise: null,
}
const sheetCacheTtlMs = Number(process.env.AGENT_SHEET_CACHE_TTL_SECONDS || 900) * 1000
const agentTeamDirectory = {
  agentsById: new Map(),
  agentsByName: new Map(),
  agentsByCompactName: new Map(),
  expiresAt: 0,
  refreshPromise: null,
}

function isTeamsConfigured() {
  return teamsWebhookUrlsByTeam.size > 0
}

function normalizeLookupValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeHeader(value) {
  return normalizeLookupValue(value).replace(/[^a-z0-9]/g, '')
}

function normalizeCompactLookupValue(value) {
  return normalizeLookupValue(value).replace(/[^a-z0-9]/g, '')
}

function normalizeTeam(value) {
  const team = normalizeLookupValue(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

  if (
    ['after sales', 'aftersales', 'after sale', 'aftersale', 'after sales team'].includes(team)
    || team.startsWith('after sales team ')
  ) {
    return 'after_sales'
  }

  if (['presales', 'pre sales', 'pre sale', 'presale', 'sales team'].includes(team)) {
    return 'presales'
  }

  if (['cmr', 'cmr team'].includes(team)) {
    return 'cmr'
  }

  return null
}

function getTeamDisplayName(team) {
  return {
    after_sales: 'After Sales',
    presales: 'Presales',
    cmr: 'CMR',
  }[team] || team
}

function getColumnIndex(headers, configuredName, fallbackNames) {
  const normalizedHeaders = headers.map(normalizeHeader)
  const candidateNames = [configuredName, ...fallbackNames]
    .filter(Boolean)
    .map(normalizeHeader)

  return normalizedHeaders.findIndex((header) => candidateNames.includes(header))
}

async function login() {
  const body = new URLSearchParams()
  body.set('username', requireEnv('ZIWO_USERNAME'))
  body.set('password', requireEnv('ZIWO_PASSWORD'))
  body.set('remember', 'true')
  body.set('deviceType', 'Web')

  const { data } = await axios.post(`${baseUrl}/auth/login`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  return data.content.access_token
}

async function getGraphAccessToken() {
  const tenantId = requireEnv('MS_GRAPH_TENANT_ID')
  const body = new URLSearchParams()
  body.set('client_id', requireEnv('MS_GRAPH_CLIENT_ID'))
  body.set('client_secret', requireEnv('MS_GRAPH_CLIENT_SECRET'))
  body.set('scope', 'https://graph.microsoft.com/.default')
  body.set('grant_type', 'client_credentials')

  const { data } = await axios.post(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )

  return data.access_token
}

async function graphGet(accessToken, path) {
  const { data } = await axios.get(`${graphBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  return data
}

function getAgentWorkbookBasePath() {
  const excelUser = encodeURIComponent(requireEnv('AGENT_SHEET_EXCEL_USER'))
  const filePath = requireEnv('AGENT_SHEET_FILE_PATH')

  return `/users/${excelUser}/drive/root:${filePath}:/workbook`
}

function getAgentWorkbookTablePath() {
  return `${getAgentWorkbookBasePath()}/tables/${encodeURIComponent(requireEnv('AGENT_SHEET_TABLE_NAME'))}`
}

function parseAgentTableRows(headers, dataRows) {
  const normalizedDataRows = dataRows.filter((row) =>
    row.some((value) => String(value ?? '').trim())
  )

  if (!headers?.length) {
    throw new Error('Agent sheet table has no columns')
  }

  const idColumn = getColumnIndex(headers, process.env.AGENT_SHEET_ID_COLUMN, [
    'id',
    'ids',
    'agent id',
    'agent ids',
    'agentid',
    'agentids',
    'ziwo id',
    'ziwo ids',
    'ziwo agent id',
    'ziwo agent ids',
    'user id',
    'user ids',
  ])
  const nameColumn = getColumnIndex(headers, process.env.AGENT_SHEET_NAME_COLUMN, [
    'name',
    'agent',
    'agent name',
    'full name',
    'username',
  ])
  const teamColumn = getColumnIndex(headers, process.env.AGENT_SHEET_TEAM_COLUMN, [
    'team',
    'department',
  ])

  if (teamColumn === -1) {
    throw new Error('Agent sheet must include a team column')
  }

  if (idColumn === -1 && nameColumn === -1) {
    throw new Error('Agent sheet must include an agent id column, an agent name column, or both')
  }

  const agentsById = new Map()
  const agentsByName = new Map()
  const agentsByCompactName = new Map()

  for (const row of normalizedDataRows) {
    const team = normalizeTeam(row[teamColumn])

    if (!team) {
      continue
    }

    const agentId = idColumn === -1 ? null : String(row[idColumn] ?? '').trim()
    const agentName = nameColumn === -1 ? null : String(row[nameColumn] ?? '').trim()
    const agentRecord = {
      agentId,
      agentName,
      team,
    }

    if (agentId) {
      agentsById.set(String(agentId), agentRecord)
    }

    if (agentName) {
      agentsByName.set(normalizeLookupValue(agentName), agentRecord)
      agentsByCompactName.set(normalizeCompactLookupValue(agentName), agentRecord)
    }
  }

  return { agentsById, agentsByName, agentsByCompactName }
}

async function refreshAgentTeamDirectory() {
  const graphAccessToken = await getGraphAccessToken()
  const tablePath = getAgentWorkbookTablePath()
  const [columns, rows] = await Promise.all([
    graphGet(graphAccessToken, `${tablePath}/columns`),
    graphGet(graphAccessToken, `${tablePath}/rows`),
  ])
  const headers = (columns.value || []).map((column) => column.name)
  const values = (rows.value || []).map((row) => row.values?.[0] || [])
  const { agentsById, agentsByName, agentsByCompactName } = parseAgentTableRows(headers, values)

  agentTeamDirectory.agentsById = agentsById
  agentTeamDirectory.agentsByName = agentsByName
  agentTeamDirectory.agentsByCompactName = agentsByCompactName
  agentTeamDirectory.expiresAt = Date.now() + sheetCacheTtlMs

  console.log(
    `Loaded ${agentsById.size} agent ids and ${agentsByName.size} agent names from team table "${process.env.AGENT_SHEET_TABLE_NAME}"`
  )
}

async function ensureAgentTeamDirectory(forceRefresh = false) {
  if (!forceRefresh && agentTeamDirectory.expiresAt > Date.now()) {
    return
  }

  if (!agentTeamDirectory.refreshPromise) {
    agentTeamDirectory.refreshPromise = refreshAgentTeamDirectory().finally(() => {
      agentTeamDirectory.refreshPromise = null
    })
  }

  await agentTeamDirectory.refreshPromise
}

async function fetchCallByCallID(accessToken, callID) {
  const params = new URLSearchParams()
  params.set('callID', callID)
  params.set('limit', '1')
  params.set('skip', '0')

  const { data } = await axios.get(`${baseUrl}/callHistory/?${params}`, {
    headers: { access_token: accessToken },
  })

  return data.content?.[0]
}

async function fetchCallsByContactNumber(accessToken, contactNumber) {
  const params = new URLSearchParams()
  params.set('contactNumber', contactNumber)
  params.set('limit', '20')
  params.set('skip', '0')

  const { data } = await axios.get(`${baseUrl}/callHistory/?${params}`, {
    headers: { access_token: accessToken },
  })

  return data.content || []
}

async function fetchCallsByCallerNumber(accessToken, callerNumber) {
  const contactNumbers = [
    callerNumber,
    String(callerNumber ?? '').replace(/\D/g, ''),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)

  for (const contactNumber of contactNumbers) {
    const calls = await fetchCallsByContactNumber(accessToken, contactNumber)
    console.log(`Fetched ${calls.length} previous calls for contactNumber=${contactNumber}`)

    if (calls.length) {
      return calls
    }
  }

  return []
}

function formatAgentDisplayName(agent) {
  const fullName = [agent.firstName, agent.lastName]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ')

  return fullName || agent.username || `Agent ${agent.id}`
}

async function refreshAgentDirectory(accessToken) {
  const { data } = await axios.get(`${baseUrl}/callHistory/listAgents?deleted=false`, {
    headers: { access_token: accessToken },
  })

  const agentsById = new Map()

  for (const agent of data.content || []) {
    agentsById.set(String(agent.id), {
      ...agent,
      displayName: formatAgentDisplayName(agent),
    })
  }

  agentDirectory.agentsById = agentsById
  agentDirectory.expiresAt = Date.now() + agentCacheTtlMs

  console.log(`Loaded ${agentsById.size} Ziwo agents for agent name lookup`)
}

async function ensureAgentDirectory(accessToken, forceRefresh = false) {
  if (!forceRefresh && agentDirectory.expiresAt > Date.now()) {
    return
  }

  if (!agentDirectory.refreshPromise) {
    agentDirectory.refreshPromise = refreshAgentDirectory(accessToken).finally(() => {
      agentDirectory.refreshPromise = null
    })
  }

  await agentDirectory.refreshPromise
}

function isCanceledCall(cdr) {
  return cancelResults.includes(cdr?.result) && cdr?.direction === 'inbound'
}

function formatDateTime(value) {
  if (!value) {
    return null
  }

  return dateTimeFormatter.format(new Date(value))
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function getAgentId(cdr) {
  return firstPresent(
    cdr.agentId,
    cdr.agentID,
    cdr.agent_id,
    cdr.agent?.id,
    cdr.offeredToAgentId,
    cdr.userId,
    cdr.userID,
    cdr.user_id,
    cdr.user?.id,
    cdr.assigneeId,
    cdr.assignee?.id
  )
}

function getCallerNumber(cdr) {
  return firstPresent(
    cdr.callerIDNumber,
    cdr.contactNumber,
    cdr.clientNumber,
    cdr.phoneNumber,
    cdr.from,
    cdr.caller?.number,
    cdr.contact?.number
  )
}

async function getAgentName(accessToken, cdr) {
  const existingAgentName = firstPresent(
    cdr.agentName,
    cdr.agent?.name,
    cdr.agent?.fullName,
    cdr.userName,
    cdr.username,
    cdr.user?.name,
    cdr.user?.fullName,
    cdr.assignee?.name,
    cdr.assignee?.fullName
  )

  if (existingAgentName) {
    return existingAgentName
  }

  const agentId = getAgentId(cdr)

  if (!agentId) {
    return null
  }

  try {
    await ensureAgentDirectory(accessToken)
  } catch (error) {
    console.warn(`Ziwo agent directory lookup failed: ${getErrorMessage(error)}`)
    return `Unknown agent ${agentId}`
  }

  let agent = agentDirectory.agentsById.get(String(agentId))

  if (!agent) {
    try {
      await ensureAgentDirectory(accessToken, true)
    } catch (error) {
      console.warn(`Ziwo agent directory refresh failed: ${getErrorMessage(error)}`)
      return `Unknown agent ${agentId}`
    }

    agent = agentDirectory.agentsById.get(String(agentId))
  }

  return agent?.displayName || `Unknown agent ${agentId}`
}

async function getAgentRoute(call) {
  if (!call.agentId) {
    return null
  }

  try {
    await ensureAgentTeamDirectory()
  } catch (error) {
    console.warn(`Agent team sheet lookup failed: ${getErrorMessage(error)}`)
    return null
  }

  const byId = agentTeamDirectory.agentsById.get(String(call.agentId))

  if (byId?.team) {
    return {
      team: byId.team,
      matchedBy: 'agentId',
      sheetAgentId: byId.agentId,
      sheetAgentName: byId.agentName,
      callAgentId: call.agentId,
      callAgentName: call.agentName,
    }
  }

  console.log(`No team mapping found in sheet for agent id "${call.agentId}" (${call.agentName || 'unknown agent'}). Check the "${process.env.AGENT_SHEET_ID_COLUMN || 'ID'}" column in "${process.env.AGENT_SHEET_TABLE_NAME}".`)
  return null
}

async function getAgentTeam(call) {
  return (await getAgentRoute(call))?.team || null
}

async function summarizeCall(accessToken, cdr) {
  return {
    callID: cdr.callID,
    result: cdr.result,
    direction: cdr.direction,
    startedAt: cdr.startedAt,
    startedAtLocal: formatDateTime(cdr.startedAt),
    endedAt: cdr.endedAt,
    endedAtLocal: formatDateTime(cdr.endedAt),
    displayTimeZone,
    callerIDNumber: getCallerNumber(cdr),
    didCalled: cdr.didCalled,
    agentId: getAgentId(cdr),
    agentName: await getAgentName(accessToken, cdr),
  }
}

function hasAgent(call) {
  return Boolean(call.agentId)
}

function getStartedAtMs(call) {
  const startedAtMs = Date.parse(call?.startedAt || '')
  return Number.isNaN(startedAtMs) ? 0 : startedAtMs
}

function getContactedAgentLabel(call) {
  return call.agentName || (call.agentId ? `Agent ${call.agentId}` : null)
}

async function findLastAssignedCallForContact(accessToken, currentCall) {
  const contactNumber = currentCall.callerIDNumber

  if (!contactNumber) {
    return null
  }

  const history = await fetchCallsByCallerNumber(accessToken, contactNumber)
  const sortedHistory = history
    .filter((cdr) => String(cdr?.callID) !== String(currentCall.callID))
    .sort((left, right) => getStartedAtMs(right) - getStartedAtMs(left))

  for (const cdr of sortedHistory) {
    const call = await summarizeCall(accessToken, cdr)

    if (hasAgent(call)) {
      call.route = await getAgentRoute(call)
      call.team = call.route?.team || null
      return call
    }
  }

  return null
}

function formatCardText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim()
}

function formatRingTime(startedAt, endedAt) {
  const startedAtMs = Date.parse(startedAt)
  const endedAtMs = Date.parse(endedAt)

  if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs) || endedAtMs < startedAtMs) {
    return 'unknown'
  }

  const totalSeconds = Math.floor((endedAtMs - startedAtMs) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`
}

function formatRoutingLog(call) {
  const route = call.route

  if (!route) {
    return `Routing: no route details available for callID=${call.callID}`
  }

  const teamName = getTeamDisplayName(route.team)
  const sheetMatch = `agent id ${route.callAgentId} matched sheet ID ${route.sheetAgentId} (${route.sheetAgentName || route.callAgentName || 'unknown agent'})`

  if (route.source === 'previous_call' && route.previousCall) {
    const previousCall = route.previousCall
    return [
      `Routing: current callID=${call.callID} had no agent; using previous call`,
      `previousCallID=${previousCall.callID}`,
      `previousStartedAt=${previousCall.startedAtLocal || previousCall.startedAt || 'unknown'}`,
      `previousEndedAt=${previousCall.endedAtLocal || previousCall.endedAt || 'unknown'}`,
      `previousResult=${previousCall.result || 'unknown'}`,
      `previousDirection=${previousCall.direction || 'unknown'}`,
      `previousCaller=${previousCall.callerIDNumber || 'unknown'}`,
      `previousDidCalled=${previousCall.didCalled || 'unknown'}`,
      `previousAgentId=${previousCall.agentId || 'unknown'}`,
      `previousAgentName=${previousCall.agentName || 'unknown'}`,
      `${sheetMatch}`,
      `team=${teamName}`,
    ].join('; ')
  }

  return `Routing: current callID=${call.callID}; ${sheetMatch}; team=${teamName}`
}

function formatCdrFetchLog(cdr) {
  return `Fetched CDR callID=${cdr.callID}, result=${cdr.result || 'unknown'}, direction=${cdr.direction || 'unknown'}`
}

async function formatTeamsWorkflowPayload(accessToken, cdr) {
  const call = await summarizeCall(accessToken, cdr)
  call.route = await getAgentRoute(call)
  call.team = call.route?.team || null

  if (!hasAgent(call)) {
    call.lastAssignedCall = await findLastAssignedCallForContact(accessToken, call)

    if (call.lastAssignedCall?.team) {
      call.team = call.lastAssignedCall.team
      call.route = {
        ...call.lastAssignedCall.route,
        source: 'previous_call',
        previousCall: call.lastAssignedCall,
      }
    }
  } else if (call.route) {
    call.route.source = 'current_call'
  }

  const lastContactedLabel = call.lastAssignedCall ? getContactedAgentLabel(call.lastAssignedCall) : null
  const facts = [
    { title: 'Time Started', value: call.startedAtLocal },
    { title: 'Time Ended', value: call.endedAtLocal },
    { title: 'Ring Time', value: formatRingTime(call.startedAt, call.endedAt) },
    { title: 'Caller Number', value: call.callerIDNumber },
    { title: 'Agent', value: call.agentName || "call didn't reach an agent" },
    { title: 'Last Contacted', value: lastContactedLabel },
    { title: 'Team', value: call.team ? getTeamDisplayName(call.team) : null },
  ]
    .filter(({ value }) => value)
    .map(({ title, value }) => ({
      title,
      value: formatCardText(value),
    }))

  return {
    call,
    payload: {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.2',
            body: [
              {
                type: 'TextBlock',
                text: 'Ziwo Missed Call',
                weight: 'Bolder',
                size: 'Medium',
              },
              ...(lastContactedLabel ? [
                {
                  type: 'TextBlock',
                  text: `Call didn't reach queue / agent, client last contacted ${lastContactedLabel}`,
                  wrap: true,
                },
              ] : []),
              {
                type: 'FactSet',
                facts,
              },
            ],
          },
        },
      ],
    },
  }
}

async function sendTeamsWorkflowMessage(webhookUrl, payload) {
  await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function logCanceledCall(accessToken, cdr, source) {
  const call = await summarizeCall(accessToken, cdr)

  console.log(`[${source}] canceled call found:`)
  console.log(JSON.stringify(call, null, 2))

  if (!call.agentId) {
    console.log(`No agent id found in CDR for callID=${call.callID}. Caller=${call.callerIDNumber || 'unknown'}`)
  } else {
    console.log(`CDR agent id for callID=${call.callID}: ${call.agentId}${call.agentName ? ` (${call.agentName})` : ''}`)
  }
}

async function main() {
  const accessToken = await login()

  console.log(`Starting Ziwo missed-call notifier: ${appVersion}`)
  console.log(`Logged in to Ziwo API: ${baseUrl}`)
  console.log(`Listening for live inbound canceled calls with result: ${cancelResults.join(', ')}`)
  console.log('Using Ziwo agent lookup endpoint: GET /callHistory/listAgents?deleted=false')

  try {
    await ensureAgentDirectory(accessToken)
  } catch (error) {
    console.warn(`Ziwo agent directory could not be loaded yet: ${getErrorMessage(error)}`)
  }

  if (isTeamsConfigured()) {
    console.log(`Teams Workflow notifications enabled for: ${[...teamsWebhookUrlsByTeam.keys()].map(getTeamDisplayName).join(', ')}`)
    try {
      await ensureAgentTeamDirectory()
    } catch (error) {
      console.warn(`Agent team sheet could not be loaded yet: ${getErrorMessage(error)}`)
    }
  } else {
    console.log('Teams notifications disabled. Set at least one team webhook URL.')
  }

  const socket = io(baseUrl, {
    query: `access_token=${encodeURIComponent(accessToken)}`,
    path: '/socket',
    reconnection: true,
    transports: ['websocket'],
  })

  socket.on('connect', () => {
    console.log('Connected to Ziwo socket')
    socket.emit('subscribe', 'GET /callHistory')
    console.log('Subscribed to GET /callHistory. Waiting for new live call events...')
  })

  socket.on('GET /callHistory', async (event) => {
    try {
      const callID = event?.content?.callID
      if (!callID) {
        console.log('Received callHistory event without callID:', event)
        return
      }

      console.log(`New callHistory event received. Fetching CDR for callID=${callID}`)
      const cdr = await fetchCallByCallID(accessToken, callID)

      if (!cdr) {
        console.log(`No CDR found for callID=${callID}`)
        return
      }

      console.log(formatCdrFetchLog(cdr))

      if (isCanceledCall(cdr)) {
        await logCanceledCall(accessToken, cdr, 'socket')
        if (isTeamsConfigured()) {
          try {
            const { call, payload } = await formatTeamsWorkflowPayload(accessToken, cdr)

            if (!hasAgent(call) && !call.lastAssignedCall) {
              console.log(`Skipping Teams message for callID=${callID}: missed call did not reach an agent, and no previous agent call was found`)
              return
            }

            if (!call.team) {
              const routeLabel = call.lastAssignedCall
                ? `last contacted ${getContactedAgentLabel(call.lastAssignedCall)}`
                : (call.agentName || call.agentId)
              console.log(`Skipping Teams message for callID=${callID}: no team mapping found for ${routeLabel}`)
              return
            }

            const webhookUrl = teamsWebhookUrlsByTeam.get(call.team)

            if (!webhookUrl) {
              console.log(`Skipping Teams message for callID=${callID}: no webhook configured for ${getTeamDisplayName(call.team)}`)
              return
            }

            await sendTeamsWorkflowMessage(webhookUrl, payload)
            console.log(`Teams message sent for callID=${callID} to ${getTeamDisplayName(call.team)}`)
            console.log(formatRoutingLog(call))
          } catch (error) {
            console.error(`Teams message failed for callID=${callID}: ${getErrorMessage(error)}`)
          }
        }
      } else {
        console.log(`Ignoring callID=${callID}: result=${cdr.result || 'unknown'}, direction=${cdr.direction || 'unknown'} does not match result=${cancelResults.join('|')} and direction=inbound`)
      }
    } catch (error) {
      console.error(getErrorMessage(error))
    }
  })

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err)
  })
}

main().catch((error) => {
  console.error(getErrorMessage(error))
  process.exitCode = 1
})

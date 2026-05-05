require('dotenv').config()

const axios = require('axios')
const io = require('socket.io-client')

const appVersion = 'teams-workflow-agent-directory-v4'

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
const teamsWebhookUrl = process.env.TEAMS_WEBHOOK_URL
const agentCacheTtlMs = Number(process.env.ZIWO_AGENT_CACHE_TTL_SECONDS || 900) * 1000
const agentDirectory = {
  agentsById: new Map(),
  expiresAt: 0,
  refreshPromise: null,
}

function isTeamsConfigured() {
  return Boolean(teamsWebhookUrl)
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
    callerIDNumber: cdr.callerIDNumber,
    didCalled: cdr.didCalled,
    queueName: firstPresent(cdr.queueName, cdr.queue?.name),
    agentId: getAgentId(cdr),
    agentName: await getAgentName(accessToken, cdr),
  }
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

async function formatTeamsWorkflowPayload(accessToken, cdr) {
  const call = await summarizeCall(accessToken, cdr)
  const facts = [
    { title: 'Time Started', value: call.startedAtLocal },
    { title: 'Time Ended', value: call.endedAtLocal },
    { title: 'Ring Time', value: formatRingTime(call.startedAt, call.endedAt) },
    { title: 'Caller Number', value: call.callerIDNumber },
    { title: 'Agent', value: call.agentName || "call didn't reach an agent" },
  ]
    .filter(({ value }) => value)
    .map(({ title, value }) => ({
      title,
      value: formatCardText(value),
    }))

  return {
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
            {
              type: 'FactSet',
              facts,
            },
          ],
        },
      },
    ],
  }
}

async function sendTeamsWorkflowMessage(payload) {
  await axios.post(teamsWebhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function logCanceledCall(accessToken, cdr, source) {
  const call = await summarizeCall(accessToken, cdr)

  console.log(`[${source}] canceled call found:`)
  console.log(JSON.stringify(call, null, 2))

  if (!call.agentName) {
    console.log(`No agent name found in CDR. Available CDR fields: ${Object.keys(cdr).sort().join(', ')}`)
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
    console.log('Teams Workflow notifications enabled')
  } else {
    console.log('Teams notifications disabled. Set TEAMS_WEBHOOK_URL.')
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

      console.log(`Fetched CDR callID=${callID}, result=${cdr.result}`)

      if (isCanceledCall(cdr)) {
        await logCanceledCall(accessToken, cdr, 'socket')
        if (isTeamsConfigured()) {
          try {
            await sendTeamsWorkflowMessage(await formatTeamsWorkflowPayload(accessToken, cdr))
            console.log(`Teams message sent for callID=${callID}`)
          } catch (error) {
            console.error(`Teams message failed for callID=${callID}: ${getErrorMessage(error)}`)
          }
        }
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

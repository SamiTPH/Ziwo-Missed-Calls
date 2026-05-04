require('dotenv').config()

const axios = require('axios')
const io = require('socket.io-client')

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

function isCanceledCall(cdr) {
  return cancelResults.includes(cdr?.result)
}

function formatDateTime(value) {
  if (!value) {
    return null
  }

  return dateTimeFormatter.format(new Date(value))
}

function summarizeCall(cdr) {
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
    queueName: cdr.queueName,
    agentName: cdr.agentName,
  }
}

function logCanceledCall(cdr, source) {
  console.log(`[${source}] canceled call found:`)
  console.log(JSON.stringify(summarizeCall(cdr), null, 2))
}

async function main() {
  const accessToken = await login()

  console.log(`Logged in to Ziwo API: ${baseUrl}`)
  console.log(`Listening for live canceled calls with result: ${cancelResults.join(', ')}`)

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
        logCanceledCall(cdr, 'socket')
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

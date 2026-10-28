'use strict'

function toMilliseconds(value) {
  const milliseconds = Date.parse(value || '')
  return Number.isNaN(milliseconds) ? null : milliseconds
}

function normalizeId(value) {
  return value === undefined || value === null || value === '' ? null : String(value)
}

function buildActiveTeamMaps(agentTeamRecords = new Map(), activeAgentsById = new Map()) {
  const teamByAgentId = new Map()
  const agentIdsByTeam = new Map()

  for (const [agentId, record] of agentTeamRecords) {
    const id = String(agentId)
    if (!activeAgentsById.has(id)) {
      continue
    }

    teamByAgentId.set(id, record.team)
    const teamAgentIds = agentIdsByTeam.get(record.team) || []
    teamAgentIds.push(id)
    agentIdsByTeam.set(record.team, teamAgentIds)
  }

  return { teamByAgentId, agentIdsByTeam }
}

function flattenCallFlow(events = [], nestedEvents = {}) {
  const byId = new Map()

  for (const event of [...events, ...Object.values(nestedEvents).flat()]) {
    const key = event?.id === undefined || event?.id === null
      ? `${event?.type}:${event?.startedAt}:${event?.agentId}:${event?.queueId}`
      : String(event.id)

    if (!byId.has(key)) {
      byId.set(key, event)
    }
  }

  return [...byId.values()].sort((left, right) => {
    const leftTime = toMilliseconds(left?.startedAt) ?? Number.MAX_SAFE_INTEGER
    const rightTime = toMilliseconds(right?.startedAt) ?? Number.MAX_SAFE_INTEGER
    return leftTime - rightTime || Number(left?.id || 0) - Number(right?.id || 0)
  })
}

function createAgentResolver(agentIdByExtension = new Map()) {
  return (event) => {
    const directId = normalizeId(event?.agentId)
    if (directId) {
      return directId
    }

    const extension = String(event?.data ?? '').trim()
    return normalizeId(agentIdByExtension.get(extension))
  }
}

function getEventTime(event) {
  return toMilliseconds(event?.startedAt)
}

function getTimelineEnd(events, cdr) {
  return Math.max(
    toMilliseconds(cdr?.endedAt) ?? 0,
    ...events.map(getEventTime).filter((time) => time !== null)
  )
}

function isBetween(event, startTime, endTime) {
  const time = getEventTime(event)
  return time !== null && time >= startTime && time <= endTime
}

function getPreviousSalesAnswer(events, beforeTime, resolveAgentId, teamByAgentId) {
  const answerTypes = new Set(['queue-agent-bridge-start', 'bridge-start', 'answered'])
  let answer = null

  for (const event of events) {
    const time = getEventTime(event)
    if (time === null || time >= beforeTime || !answerTypes.has(event.type)) {
      continue
    }

    const agentId = resolveAgentId(event)
    if (agentId && teamByAgentId.get(agentId) === 'presales') {
      answer = event
    }
  }

  return answer
}

function hasTransferBetween(events, startTime, endTime) {
  return events.some((event) => (
    ['transfer', 'attended-transfer'].includes(event.type)
    && isBetween(event, startTime, endTime)
  ))
}

function calculateDurationSeconds(startEvent, endEvent) {
  const startTime = getEventTime(startEvent)
  const endTime = getEventTime(endEvent)

  if (startTime === null || endTime === null || endTime < startTime) {
    return null
  }

  return Math.floor((endTime - startTime) / 1000)
}

function findNextEvent(events, startTime, predicate, endTime = Number.MAX_SAFE_INTEGER) {
  return events.find((event) => {
    const time = getEventTime(event)
    return time !== null && time >= startTime && time <= endTime && predicate(event)
  }) || null
}

function buildQueueHandoffs({
  events,
  cdr,
  afterSalesQueueIds,
  resolveAgentId,
  teamByAgentId,
}) {
  const handoffs = []
  const callEndTime = getTimelineEnd(events, cdr)

  for (const entry of events.filter((event) => (
    event.type === 'queue-enter' && afterSalesQueueIds.has(normalizeId(event.queueId))
  ))) {
    const entryTime = getEventTime(entry)
    if (entryTime === null) {
      continue
    }

    const exit = findNextEvent(events, entryTime, (event) => (
      event.type === 'queue-exit' && normalizeId(event.queueId) === normalizeId(entry.queueId)
    ), callEndTime)
    const endTime = exit ? getEventTime(exit) : callEndTime
    const salesAnswer = getPreviousSalesAnswer(events, entryTime, resolveAgentId, teamByAgentId)
    const salesAnswerTime = salesAnswer ? getEventTime(salesAnswer) : null

    if (salesAnswerTime === null || !hasTransferBetween(events, salesAnswerTime, entryTime)) {
      continue
    }

    const starts = events.filter((event) => {
      if (event.type !== 'queue-agent-offering-start' || !isBetween(event, entryTime, endTime)) {
        return false
      }
      const agentId = resolveAgentId(event)
      return normalizeId(event.queueId) === normalizeId(entry.queueId) && Boolean(agentId)
    })
    const answer = findNextEvent(events, entryTime, (event) => (
      event.type === 'queue-agent-bridge-start'
      && normalizeId(event.queueId) === normalizeId(entry.queueId)
    ), endTime)
    const callTerminal = findNextEvent(events, entryTime, (event) => (
      event.type === 'bridge-end'
    ), callEndTime)

    const attempts = starts.map((start, index) => {
      const agentId = resolveAgentId(start)
      const nextStartTime = index + 1 < starts.length
        ? getEventTime(starts[index + 1])
        : endTime
      const end = findNextEvent(events, getEventTime(start), (event) => (
        ['queue-agent-offering-end', 'queue-agent-bridge-start'].includes(event.type)
        && resolveAgentId(event) === agentId
        && normalizeId(event.queueId) === normalizeId(entry.queueId)
      ), nextStartTime)

      return {
        agentId,
        startedAt: start.startedAt,
        endedAt: end?.startedAt || null,
        durationSeconds: calculateDurationSeconds(start, end),
      }
    })

    const hasTerminalEvidence = Boolean(exit || answer)
      || (Boolean(callTerminal) && attempts.every(({ endedAt }) => Boolean(endedAt)))

    handoffs.push({
      key: `queue:${normalizeId(entry.queueId)}:${entry.id}`,
      sourceKey: String(salesAnswer.id ?? salesAnswer.startedAt),
      type: 'queue',
      queueId: normalizeId(entry.queueId),
      startedAt: entry.startedAt,
      endedAt: exit?.startedAt || cdr?.endedAt || null,
      status: answer ? 'answered' : (attempts.length && hasTerminalEvidence ? 'missed' : 'incomplete'),
      attempts,
    })
  }

  return handoffs
}

function buildDirectHandoffs({
  events,
  cdr,
  afterSalesAgentIds,
  resolveAgentId,
  teamByAgentId,
}) {
  const handoffGroups = new Map()
  const callEndTime = getTimelineEnd(events, cdr)
  const transfers = events.filter((event) => ['transfer', 'attended-transfer'].includes(event.type))

  for (let index = 0; index < transfers.length; index += 1) {
    const transfer = transfers[index]
    const transferTime = getEventTime(transfer)
    const agentId = resolveAgentId(transfer)

    if (transferTime === null || !agentId || !afterSalesAgentIds.has(agentId)) {
      continue
    }

    const salesAnswer = getPreviousSalesAnswer(events, transferTime, resolveAgentId, teamByAgentId)
    if (!salesAnswer) {
      continue
    }

    const nextTransferTime = index + 1 < transfers.length
      ? getEventTime(transfers[index + 1])
      : callEndTime
    const groupKey = String(salesAnswer.id ?? salesAnswer.startedAt)
    const group = handoffGroups.get(groupKey) || {
      key: `direct:${groupKey}`,
      sourceKey: groupKey,
      type: 'direct',
      queueId: null,
      startedAt: transfer.startedAt,
      endedAt: null,
      statuses: [],
      attempts: [],
    }
    const start = findNextEvent(events, transferTime, (event) => (
      event.type === 'offering-start'
      && resolveAgentId(event) === agentId
      && (event.queueId === null || event.queueId === undefined)
    ), nextTransferTime)

    if (!start) {
      group.statuses.push('incomplete')
      handoffGroups.set(groupKey, group)
      continue
    }

    const startTime = getEventTime(start)
    const answered = findNextEvent(events, startTime, (event) => (
      ['answered', 'bridge-start', 'queue-agent-bridge-start'].includes(event.type)
      && resolveAgentId(event) === agentId
    ), nextTransferTime)
    const end = findNextEvent(events, startTime, (event) => (
      ['bridge-end', 'queue-agent-offering-end'].includes(event.type)
      && resolveAgentId(event) === agentId
    ), nextTransferTime)

    if ((getEventTime(start) ?? Number.MAX_SAFE_INTEGER) < (toMilliseconds(group.startedAt) ?? Number.MAX_SAFE_INTEGER)) {
      group.startedAt = start.startedAt
    }
    group.endedAt = end?.startedAt || group.endedAt
    group.statuses.push(answered ? 'answered' : (end ? 'missed' : 'incomplete'))
    group.attempts.push({
      agentId,
      startedAt: start.startedAt,
      endedAt: end?.startedAt || null,
      durationSeconds: calculateDurationSeconds(start, end),
    })
    handoffGroups.set(groupKey, group)
  }

  return [...handoffGroups.values()].map(({ statuses, ...handoff }) => ({
    ...handoff,
    status: statuses.includes('answered')
      ? 'answered'
      : (statuses.includes('incomplete') ? 'incomplete' : 'missed'),
  }))
}

function interpretSalesTransferCall({
  cdr,
  events = [],
  nestedEvents = {},
  targetQueueIds = [],
  targetAgentIds = [],
  teamByAgentId = new Map(),
  agentIdByExtension = new Map(),
}) {
  const normalizedEvents = flattenCallFlow(events, nestedEvents)
  const queueIds = new Set(targetQueueIds.map(normalizeId).filter(Boolean))
  const agentIds = new Set(targetAgentIds.map(normalizeId).filter(Boolean))
  const normalizedTeams = new Map([...teamByAgentId].map(([id, team]) => [normalizeId(id), team]))
  const normalizedExtensions = new Map([...agentIdByExtension].map(([extension, id]) => [String(extension).trim(), normalizeId(id)]))
  const resolveAgentId = createAgentResolver(normalizedExtensions)

  const rawHandoffs = [
    ...buildQueueHandoffs({
      events: normalizedEvents,
      cdr,
      afterSalesQueueIds: queueIds,
      resolveAgentId,
      teamByAgentId: normalizedTeams,
    }),
    ...buildDirectHandoffs({
      events: normalizedEvents,
      cdr,
      afterSalesAgentIds: agentIds,
      resolveAgentId,
      teamByAgentId: normalizedTeams,
    }),
  ]
  const groupedHandoffs = new Map()

  for (const handoff of rawHandoffs) {
    const group = groupedHandoffs.get(handoff.sourceKey) || {
      key: `sales:${handoff.sourceKey}`,
      sourceKey: handoff.sourceKey,
      types: new Set(),
      queueId: handoff.queueId,
      startedAt: handoff.startedAt,
      endedAt: handoff.endedAt,
      statuses: [],
      attempts: [],
    }
    group.types.add(handoff.type)
    group.queueId ||= handoff.queueId
    group.statuses.push(handoff.status)
    group.attempts.push(...handoff.attempts)

    if ((toMilliseconds(handoff.startedAt) ?? Number.MAX_SAFE_INTEGER) < (toMilliseconds(group.startedAt) ?? Number.MAX_SAFE_INTEGER)) {
      group.startedAt = handoff.startedAt
    }
    if ((toMilliseconds(handoff.endedAt) ?? 0) > (toMilliseconds(group.endedAt) ?? 0)) {
      group.endedAt = handoff.endedAt
    }

    groupedHandoffs.set(handoff.sourceKey, group)
  }

  const handoffs = [...groupedHandoffs.values()].map(({ types, statuses, ...handoff }) => ({
    ...handoff,
    type: types.size === 1 ? [...types][0] : 'mixed',
    status: statuses.includes('answered')
      ? 'answered'
      : (statuses.includes('incomplete') ? 'incomplete' : 'missed'),
    attempts: handoff.attempts.sort((left, right) => (
      (toMilliseconds(left.startedAt) ?? Number.MAX_SAFE_INTEGER)
      - (toMilliseconds(right.startedAt) ?? Number.MAX_SAFE_INTEGER)
    )),
  })).sort((left, right) => toMilliseconds(left.startedAt) - toMilliseconds(right.startedAt))

  return handoffs
}

function interpretAfterSalesCall(options) {
  return interpretSalesTransferCall({
    ...options,
    targetQueueIds: options.afterSalesQueueIds,
    targetAgentIds: options.afterSalesAgentIds,
  })
}

function shouldRetryAfterSalesCallFlow({ events = [], handoffs = [], potentialAfterSalesEvent = false }) {
  return events.length === 0
    || handoffs.some(({ status }) => status === 'incomplete')
    || (handoffs.length === 0 && potentialAfterSalesEvent)
}

async function resolveAfterSalesCallFlow({
  fetchCallFlow,
  interpret,
  hasPotentialEvent,
  retryDelaysMs = [],
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = () => {},
}) {
  const attempts = [0, ...retryDelaysMs]
  let result = { events: [], nestedEvents: {}, handoffs: [] }

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const delay = attempts[attemptIndex]
    if (delay > 0) {
      await wait(delay)
    }

    const { events, nestedEvents } = await fetchCallFlow()
    const handoffs = interpret({ events, nestedEvents })
    const potentialAfterSalesEvent = events.some(hasPotentialEvent)
    result = { events, nestedEvents, handoffs }

    if (!shouldRetryAfterSalesCallFlow({ events, handoffs, potentialAfterSalesEvent })) {
      break
    }

    if (attemptIndex < attempts.length - 1) {
      onRetry(attemptIndex + 1)
    }
  }

  return result
}

module.exports = {
  buildActiveTeamMaps,
  calculateDurationSeconds,
  flattenCallFlow,
  interpretAfterSalesCall,
  interpretSalesTransferCall,
  resolveAfterSalesCallFlow,
  resolveTransferCallFlow: resolveAfterSalesCallFlow,
  shouldRetryAfterSalesCallFlow,
}

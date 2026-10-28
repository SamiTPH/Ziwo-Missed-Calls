'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildActiveTeamMaps,
  interpretAfterSalesCall,
  interpretSalesTransferCall,
  resolveAfterSalesCallFlow,
  shouldRetryAfterSalesCallFlow,
} = require('../after-sales-call')

const teams = new Map([
  ['44', 'presales'],
  ['82', 'after_sales'],
  ['83', 'after_sales'],
  ['94', 'after_sales'],
])

function interpret(events, nestedEvents = {}, endedAt = '2026-10-12T06:10:00.000Z') {
  return interpretAfterSalesCall({
    cdr: { endedAt },
    events,
    nestedEvents,
    afterSalesQueueIds: ['8'],
    afterSalesAgentIds: ['82', '83', '94'],
    teamByAgentId: teams,
  })
}

test('reconstructs ordered queue misses and preserves repeated agents', () => {
  const root = [
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', data: 'after-sales', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 5, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:41.000Z' },
    { id: 7, type: 'queue-agent-offering-end', agentId: 83, queueId: 8, startedAt: '2026-10-12T06:01:11.000Z' },
    { id: 9, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:01:16.000Z' },
    { id: 10, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:01:16.100Z' },
  ]
  const nested = {
    4: [
      { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
      { id: 6, type: 'queue-agent-offering-start', agentId: 83, queueId: 8, startedAt: '2026-10-12T06:00:41.000Z' },
      { id: 8, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:01:11.000Z' },
    ],
  }

  const [handoff] = interpret(root.reverse(), nested)

  assert.equal(handoff.status, 'missed')
  assert.deepEqual(handoff.attempts.map(({ agentId }) => agentId), ['82', '83', '82'])
  assert.equal(handoff.attempts[2].durationSeconds, 5)
})

test('suppresses a queue handoff when an After Sales agent answers', () => {
  const handoffs = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 5, type: 'queue-agent-bridge-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:20.000Z' },
    { id: 6, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:02:00.000Z' },
  ])

  assert.equal(handoffs[0].status, 'answered')
})

test('recognizes a missed direct transfer after Sales answered', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:05:40.560Z' },
    { id: 2, type: 'transfer', agentId: 82, data: '0042', startedAt: '2026-10-12T06:06:13.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, data: '0042', startedAt: '2026-10-12T06:06:13.900Z' },
    { id: 4, type: 'bridge-end', agentId: 82, data: '0042', startedAt: '2026-10-12T06:06:44.000Z' },
  ], {}, '2026-10-12T06:06:44.020Z')

  assert.equal(handoff.type, 'direct')
  assert.equal(handoff.status, 'missed')
  assert.equal(handoff.attempts[0].agentId, '82')
  assert.equal(handoff.attempts[0].durationSeconds, 30)
})

test('does not classify a direct After Sales offer without a prior Sales answer', () => {
  const handoffs = interpret([
    { id: 1, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'offering-start', agentId: 82, startedAt: '2026-10-12T06:00:01.000Z' },
    { id: 3, type: 'bridge-end', agentId: 82, startedAt: '2026-10-12T06:00:06.000Z' },
  ])

  assert.deepEqual(handoffs, [])
})

test('marks direct transfers with missing terminal evidence incomplete', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, startedAt: '2026-10-12T06:00:11.000Z' },
  ])

  assert.equal(handoff.status, 'incomplete')
  assert.equal(handoff.attempts[0].durationSeconds, null)
})

test('suppresses a direct handoff when the destination agent answers', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, data: '0042', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, data: '0042', startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'answered', agentId: 82, data: '0042', startedAt: '2026-10-12T06:00:15.000Z' },
    { id: 5, type: 'bridge-end', agentId: 82, data: '0042', startedAt: '2026-10-12T06:01:00.000Z' },
  ])

  assert.equal(handoff.status, 'answered')
})

test('does not classify a direct entry to the After Sales queue without a Sales transfer', () => {
  const handoffs = interpret([
    { id: 1, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:01.000Z' },
    { id: 3, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:06.000Z' },
    { id: 4, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:00:07.000Z' },
  ])

  assert.deepEqual(handoffs, [])
})

test('can resolve direct transfers by ccLogin when agentId is absent', () => {
  const [handoff] = interpretAfterSalesCall({
    cdr: { endedAt: '2026-10-12T06:00:20.000Z' },
    events: [
      { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
      { id: 2, type: 'transfer', data: '0042', startedAt: '2026-10-12T06:00:10.000Z' },
      { id: 3, type: 'offering-start', data: '0042', startedAt: '2026-10-12T06:00:11.000Z' },
      { id: 4, type: 'bridge-end', data: '0042', startedAt: '2026-10-12T06:00:16.000Z' },
    ],
    afterSalesQueueIds: ['8'],
    afterSalesAgentIds: ['82'],
    teamByAgentId: teams,
    agentIdByExtension: new Map([['0042', '82']]),
  })

  assert.equal(handoff.status, 'missed')
  assert.equal(handoff.attempts[0].agentId, '82')
  assert.equal(handoff.attempts[0].durationSeconds, 5)
})

test('combines sequential direct transfers into one ordered missed handoff', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'bridge-end', agentId: 82, startedAt: '2026-10-12T06:00:41.000Z' },
    { id: 5, type: 'transfer', agentId: 83, startedAt: '2026-10-12T06:00:42.000Z' },
    { id: 6, type: 'offering-start', agentId: 83, startedAt: '2026-10-12T06:00:43.000Z' },
    { id: 7, type: 'bridge-end', agentId: 83, startedAt: '2026-10-12T06:00:48.000Z' },
  ])

  assert.equal(handoff.status, 'missed')
  assert.deepEqual(handoff.attempts.map(({ agentId }) => agentId), ['82', '83'])
  assert.equal(handoff.attempts[1].durationSeconds, 5)
})

test('suppresses a direct transfer chain when a later After Sales agent answers', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'bridge-end', agentId: 82, startedAt: '2026-10-12T06:00:41.000Z' },
    { id: 5, type: 'transfer', agentId: 83, startedAt: '2026-10-12T06:00:42.000Z' },
    { id: 6, type: 'offering-start', agentId: 83, startedAt: '2026-10-12T06:00:43.000Z' },
    { id: 7, type: 'answered', agentId: 83, startedAt: '2026-10-12T06:00:48.000Z' },
    { id: 8, type: 'bridge-end', agentId: 83, startedAt: '2026-10-12T06:01:30.000Z' },
  ])

  assert.equal(handoff.status, 'answered')
  assert.deepEqual(handoff.attempts.map(({ agentId }) => agentId), ['82', '83'])
})

test('marks a partial queue timeline incomplete instead of missed', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:12.000Z' },
  ])

  assert.equal(handoff.status, 'incomplete')
})

test('suppresses a missed queue stage when a later direct After Sales agent answers', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:12.000Z' },
    { id: 5, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:42.000Z' },
    { id: 6, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:00:43.000Z' },
    { id: 7, type: 'transfer', agentId: 83, startedAt: '2026-10-12T06:00:44.000Z' },
    { id: 8, type: 'offering-start', agentId: 83, startedAt: '2026-10-12T06:00:45.000Z' },
    { id: 9, type: 'answered', agentId: 83, startedAt: '2026-10-12T06:00:50.000Z' },
    { id: 10, type: 'bridge-end', agentId: 83, startedAt: '2026-10-12T06:01:30.000Z' },
  ])

  assert.equal(handoff.type, 'mixed')
  assert.equal(handoff.status, 'answered')
  assert.deepEqual(handoff.attempts.map(({ agentId }) => agentId), ['82', '83'])
})

test('treats any bridge in the configured After Sales queue as answered', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:12.000Z' },
    { id: 5, type: 'queue-agent-bridge-start', agentId: 999, queueId: 8, startedAt: '2026-10-12T06:00:20.000Z' },
    { id: 6, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:01:00.000Z' },
  ])

  assert.equal(handoff.status, 'answered')
})

test('accepts fractional CallFlow events after a whole-second CDR end', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'offering-start', agentId: 82, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'bridge-end', agentId: 82, startedAt: '2026-10-12T06:00:41.020Z' },
  ], {}, '2026-10-12T06:00:41.000Z')

  assert.equal(handoff.status, 'missed')
  assert.equal(handoff.attempts[0].durationSeconds, 30)
})

test('does not treat queue offer-end as handoff completion without queue or call terminal evidence', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
    { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
    { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:12.000Z' },
    { id: 5, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:42.000Z' },
  ])

  assert.equal(handoff.status, 'incomplete')
})

test('retains a known direct transfer as incomplete while its offering stage is delayed', () => {
  const [handoff] = interpret([
    { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
    { id: 2, type: 'transfer', agentId: 82, startedAt: '2026-10-12T06:00:10.000Z' },
  ])

  assert.equal(handoff.status, 'incomplete')
  assert.deepEqual(handoff.attempts, [])
})

test('retries when the initial CallFlow has not been persisted yet', () => {
  assert.equal(shouldRetryAfterSalesCallFlow({ events: [], handoffs: [] }), true)
  assert.equal(shouldRetryAfterSalesCallFlow({
    events: [{ id: 1, type: 'ivr-enter' }],
    handoffs: [],
    potentialAfterSalesEvent: false,
  }), false)
})

test('retrieves again when the first CallFlow response is empty', async () => {
  const responses = [
    { events: [], nestedEvents: {} },
    { events: [{ id: 1, type: 'transfer' }], nestedEvents: {} },
  ]
  let fetchCount = 0
  const result = await resolveAfterSalesCallFlow({
    fetchCallFlow: async () => responses[fetchCount++],
    interpret: ({ events }) => events.length ? [{ status: 'missed' }] : [],
    hasPotentialEvent: ({ type }) => type === 'transfer',
    retryDelaysMs: [1000],
    wait: async () => {},
  })

  assert.equal(fetchCount, 2)
  assert.deepEqual(result.handoffs, [{ status: 'missed' }])
})

test('applies the same transfer rules to the CMR queue', () => {
  const [handoff] = interpretSalesTransferCall({
    cdr: { endedAt: '2026-10-12T06:01:00.000Z' },
    events: [
      { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
      { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
      { id: 3, type: 'queue-enter', queueId: 9, startedAt: '2026-10-12T06:00:11.000Z' },
      { id: 4, type: 'queue-agent-offering-start', agentId: 107, queueId: 9, startedAt: '2026-10-12T06:00:12.000Z' },
      { id: 5, type: 'queue-agent-offering-end', agentId: 107, queueId: 9, startedAt: '2026-10-12T06:00:42.000Z' },
      { id: 6, type: 'queue-agent-offering-start', agentId: 108, queueId: 9, startedAt: '2026-10-12T06:00:43.000Z' },
      { id: 7, type: 'queue-agent-offering-end', agentId: 108, queueId: 9, startedAt: '2026-10-12T06:00:48.000Z' },
      { id: 8, type: 'queue-exit', queueId: 9, startedAt: '2026-10-12T06:00:49.000Z' },
    ],
    targetQueueIds: ['9'],
    targetAgentIds: ['107', '108'],
    teamByAgentId: new Map([['44', 'presales'], ['107', 'cmr'], ['108', 'cmr']]),
  })

  assert.equal(handoff.status, 'missed')
  assert.deepEqual(handoff.attempts.map(({ agentId }) => agentId), ['107', '108'])
  assert.equal(handoff.attempts[1].durationSeconds, 5)
})

test('keeps After Sales and CMR interpretations isolated', () => {
  const common = {
    cdr: { endedAt: '2026-10-12T06:02:00.000Z' },
    events: [
      { id: 1, type: 'queue-agent-bridge-start', agentId: 44, queueId: 1, startedAt: '2026-10-12T06:00:00.000Z' },
      { id: 2, type: 'transfer', startedAt: '2026-10-12T06:00:10.000Z' },
      { id: 3, type: 'queue-enter', queueId: 8, startedAt: '2026-10-12T06:00:11.000Z' },
      { id: 4, type: 'queue-agent-offering-start', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:12.000Z' },
      { id: 5, type: 'queue-agent-offering-end', agentId: 82, queueId: 8, startedAt: '2026-10-12T06:00:42.000Z' },
      { id: 6, type: 'queue-exit', queueId: 8, startedAt: '2026-10-12T06:00:43.000Z' },
      { id: 7, type: 'transfer', startedAt: '2026-10-12T06:00:50.000Z' },
      { id: 8, type: 'queue-enter', queueId: 9, startedAt: '2026-10-12T06:00:51.000Z' },
      { id: 9, type: 'queue-agent-offering-start', agentId: 107, queueId: 9, startedAt: '2026-10-12T06:00:52.000Z' },
      { id: 10, type: 'queue-agent-bridge-start', agentId: 107, queueId: 9, startedAt: '2026-10-12T06:01:00.000Z' },
      { id: 11, type: 'queue-exit', queueId: 9, startedAt: '2026-10-12T06:01:30.000Z' },
    ],
    teamByAgentId: new Map([['44', 'presales'], ['82', 'after_sales'], ['107', 'cmr']]),
  }
  const [afterSales] = interpretSalesTransferCall({
    ...common,
    targetQueueIds: ['8'],
    targetAgentIds: ['82'],
  })
  const [cmr] = interpretSalesTransferCall({
    ...common,
    targetQueueIds: ['9'],
    targetAgentIds: ['107'],
  })

  assert.equal(afterSales.status, 'missed')
  assert.equal(cmr.status, 'answered')
})

test('ignores stale sheet agents that are absent from the active Ziwo directory', () => {
  const { teamByAgentId, agentIdsByTeam } = buildActiveTeamMaps(new Map([
    ['82', { team: 'after_sales' }],
    ['124', { team: 'after_sales' }],
    ['107', { team: 'cmr' }],
  ]), new Map([
    ['82', {}],
    ['107', {}],
  ]))

  assert.deepEqual(agentIdsByTeam.get('after_sales'), ['82'])
  assert.deepEqual(agentIdsByTeam.get('cmr'), ['107'])
  assert.equal(teamByAgentId.has('124'), false)
})

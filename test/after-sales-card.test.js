'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { formatAfterSalesWorkflowPayload, formatTransferWorkflowPayload } = require('../after-sales-card')

test('After Sales card lists attempts and shows duration only for the final agent', () => {
  const payload = formatAfterSalesWorkflowPayload({
    startedAt: '2026-10-12T06:00:00.000Z',
    endedAt: '2026-10-12T06:01:05.000Z',
    callerIDNumber: '+0000000000',
  }, {
    type: 'queue',
    attempts: [
      { agentId: '82', durationSeconds: 30 },
      { agentId: '83', durationSeconds: 5 },
    ],
  }, {
    formatDateTime: (value) => value,
    getCallerNumber: (cdr) => cdr.callerIDNumber,
    getAgentDisplayName: (agentId) => `Agent ${agentId}`,
  })
  const body = payload.attachments[0].content.body
  const facts = body.find(({ type }) => type === 'FactSet').facts
  const factsByTitle = new Map(facts.map(({ title, value }) => [title, value]))

  assert.deepEqual(facts.map(({ title }) => title), [
    'Time Started',
    'Time Ended',
    'Caller Number',
    'Agent 1',
    'Agent 2',
    'Team',
  ])
  assert.equal(factsByTitle.get('Agent 1'), 'Agent 82')
  assert.equal(factsByTitle.get('Agent 2'), 'Agent 83 (5 seconds)')
  assert.equal(factsByTitle.has('Last Contacted'), false)
  assert.equal(factsByTitle.has('Ring Time'), false)
  assert.doesNotMatch(JSON.stringify(payload), /Call didn't reach queue|Last Contacted/)
})

test('CMR transfer card uses the same attempt format with the CMR destination', () => {
  const payload = formatTransferWorkflowPayload({
    startedAt: '2026-10-12T06:00:00.000Z',
    endedAt: '2026-10-12T06:00:05.000Z',
    callerIDNumber: '+0000000000',
  }, {
    type: 'direct',
    attempts: [{ agentId: '107', durationSeconds: 5 }],
  }, {
    teamDisplayName: 'CMR',
    formatDateTime: (value) => value,
    getCallerNumber: (cdr) => cdr.callerIDNumber,
    getAgentDisplayName: () => 'CMR Ziwo1',
  })
  const body = payload.attachments[0].content.body
  const facts = body.find(({ type }) => type === 'FactSet').facts

  assert.equal(facts.find(({ title }) => title === 'Agent 1').value, 'CMR Ziwo1 (5 seconds)')
  assert.equal(facts.find(({ title }) => title === 'Team').value, 'CMR')
  assert.match(JSON.stringify(payload), /Sales transfer to a CMR agent was not answered/)
})

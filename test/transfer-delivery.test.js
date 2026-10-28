'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { deliverTransferHandoffs } = require('../transfer-delivery')

test('continues to CMR when After Sales delivery fails', async () => {
  const attemptedTeams = []
  const failures = []
  const result = await deliverTransferHandoffs({
    cdr: { callID: 'call-1' },
    handoffs: [
      { team: 'after_sales', key: 'sales:1' },
      { team: 'cmr', key: 'sales:1' },
    ],
    deliveredKeys: new Set(),
    inFlightKeys: new Set(),
    buildPayload: (handoff) => ({ team: handoff.team }),
    send: async (team) => {
      attemptedTeams.push(team)
      if (team === 'after_sales') {
        throw new Error('After Sales webhook failed')
      }
    },
    onFailure: (handoff) => failures.push(handoff.team),
  })

  assert.deepEqual(attemptedTeams, ['after_sales', 'cmr'])
  assert.deepEqual(failures, ['after_sales'])
  assert.deepEqual(result, { sent: 1, failed: 1 })
})

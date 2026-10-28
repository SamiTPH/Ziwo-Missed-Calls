'use strict'

function formatAttemptDuration(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return 'ring duration unavailable'
  }

  const wholeSeconds = Math.floor(durationSeconds)
  return `${wholeSeconds} second${wholeSeconds === 1 ? '' : 's'}`
}

function formatTransferWorkflowPayload(cdr, handoff, {
  teamDisplayName,
  formatDateTime,
  getCallerNumber,
  getAgentDisplayName,
  formatText = (value) => String(value ?? '').replace(/\r?\n/g, ' ').trim(),
}) {
  const attempts = handoff.attempts.map((attempt, index) => {
    const isLast = index === handoff.attempts.length - 1
    const duration = isLast ? ` (${formatAttemptDuration(attempt.durationSeconds)})` : ''
    return {
      title: `Agent ${index + 1}`,
      value: `${getAgentDisplayName(attempt.agentId)}${duration}`,
    }
  })
  const facts = [
    { title: 'Time Started', value: formatDateTime(cdr.startedAt) },
    { title: 'Time Ended', value: formatDateTime(cdr.endedAt) },
    { title: 'Caller Number', value: getCallerNumber(cdr) },
    ...attempts,
    { title: 'Team', value: teamDisplayName },
  ]
    .filter(({ value }) => value)
    .map(({ title, value }) => ({ title, value: formatText(value) }))

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
              type: 'TextBlock',
              text: handoff.type === 'queue'
                ? `Sales transfer to the ${teamDisplayName} queue was not answered`
                : (handoff.type === 'direct'
                  ? `Sales transfer to a ${teamDisplayName} agent was not answered`
                  : `Sales transfer to ${teamDisplayName} was not answered`),
              wrap: true,
            },
            { type: 'FactSet', facts },
          ],
        },
      },
    ],
  }
}

function formatAfterSalesWorkflowPayload(cdr, handoff, options) {
  return formatTransferWorkflowPayload(cdr, handoff, {
    ...options,
    teamDisplayName: 'After Sales',
  })
}

module.exports = {
  formatAfterSalesWorkflowPayload,
  formatAttemptDuration,
  formatTransferWorkflowPayload,
}

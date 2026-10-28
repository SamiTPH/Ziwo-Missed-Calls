'use strict'

async function deliverTransferHandoffs({
  cdr,
  handoffs,
  deliveredKeys,
  inFlightKeys,
  buildPayload,
  send,
  onDuplicate = () => {},
  onSuccess = () => {},
  onFailure = () => {},
}) {
  let sent = 0
  let failed = 0

  for (const handoff of handoffs) {
    const deliveryKey = `${handoff.team}:${cdr.callID}:${handoff.key}`
    if (deliveredKeys.has(deliveryKey) || inFlightKeys.has(deliveryKey)) {
      onDuplicate(handoff, deliveryKey)
      continue
    }

    inFlightKeys.add(deliveryKey)
    try {
      await send(handoff.team, buildPayload(handoff))
      deliveredKeys.add(deliveryKey)
      sent += 1
      onSuccess(handoff, deliveryKey)
    } catch (error) {
      failed += 1
      onFailure(handoff, deliveryKey, error)
    } finally {
      inFlightKeys.delete(deliveryKey)
    }
  }

  return { sent, failed }
}

module.exports = { deliverTransferHandoffs }

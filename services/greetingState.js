const reservedGreetings = new Set();

export function hasGreetingBeenSent(lead) {
  if (!lead) {
    return false;
  }
  if (lead.greeting_sent === true) {
    return true;
  }
  if (lead.greeting_sent === false) {
    return false;
  }
  return Boolean(lead.lastGreetingDate);
}

export function buildShouldGreetState(lead) {
  const shouldGreet =
    !hasGreetingBeenSent(lead) && !reservedGreetings.has(lead?.leadId);
  return { should_greet: shouldGreet };
}

export function reserveGreeting(leadId) {
  if (!leadId) {
    return false;
  }
  if (reservedGreetings.has(leadId)) {
    return false;
  }
  reservedGreetings.add(leadId);
  return true;
}

export function releaseGreeting(leadId) {
  if (leadId) {
    reservedGreetings.delete(leadId);
  }
}

export function isGreetingReserved(leadId) {
  return reservedGreetings.has(leadId);
}

export async function finalizeGreetingAfterSend({
  leadId,
  shouldGreet,
  sendSucceeded,
  updateLead,
}) {
  if (!shouldGreet) {
    return { greeting_sent: false, persisted: false };
  }

  if (sendSucceeded) {
    await updateLead(leadId, { greeting_sent: true });
    releaseGreeting(leadId);
    return { greeting_sent: true, persisted: true };
  }

  releaseGreeting(leadId);
  return { greeting_sent: false, persisted: false };
}

export function resetGreetingReservationsForTests() {
  reservedGreetings.clear();
}

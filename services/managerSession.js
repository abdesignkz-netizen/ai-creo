let pendingOutbound = null;

export function setPendingOutbound(payload) {
  pendingOutbound = {
    phone: payload.phone,
    draft: payload.draft || "",
    instruction: payload.instruction || "",
    createdAt: Date.now(),
  };
}

export function getPendingOutbound() {
  if (!pendingOutbound) {
    return null;
  }
  if (Date.now() - pendingOutbound.createdAt > 30 * 60 * 1000) {
    pendingOutbound = null;
    return null;
  }
  return pendingOutbound;
}

export function clearPendingOutbound() {
  pendingOutbound = null;
}

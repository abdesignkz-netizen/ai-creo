import { log } from "./logger.js";

function enabled() {
  return Boolean(process.env.CRM_EVENTS_URL && process.env.CRM_BRIDGE_SECRET);
}

export function notifyCrm(event) {
  if (!enabled()) {
    return;
  }
  fetch(process.env.CRM_EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRM_BRIDGE_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...event,
      sentAt: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(3000),
  }).catch((error) => {
    log("CRM SYNC", { error: error.message, failOpen: true });
  });
}

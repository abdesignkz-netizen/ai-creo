import { Router } from "express";
import { addManagerInstruction, getLeadById, listAllLeads, updateLead } from "./leadService.js";
import { abortPendingClientChat, clearClientOutboundBlock } from "./clientOutboundGate.js";
import { sendWhatsAppMessage } from "./whatsappService.js";
import { toChatId } from "./phoneService.js";
import { log } from "./logger.js";

function authorize(req, res, next) {
  const expected = process.env.CRM_BRIDGE_SECRET;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function createCrmInternalRouter() {
  const router = Router();
  router.use(authorize);

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      sender: "whatsappService.js",
      managerControl: "handleManagerMessage",
      note: "CRM не является вторым отправителем",
    });
  });

  router.get("/leads", async (_req, res) => {
    const leads = await listAllLeads();
    res.json({
      leads: leads.map((lead) => ({
        leadId: lead.leadId,
        clientPhone: lead.clientPhone,
        clientName: lead.clientName,
        aiMode: lead.aiMode,
        status: lead.status,
        lastClientMessage: lead.lastClientMessage,
        lastAIMessage: lead.lastAIMessage,
        conversationHistory: lead.conversationHistory || [],
      })),
    });
  });

  router.get("/leads/:leadId", async (req, res) => {
    const lead = await getLeadById(req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ lead });
  });

  router.post("/leads/:leadId/mode", async (req, res) => {
    const mode = String(req.body?.mode || "").toUpperCase();
    if (!["AUTO", "HUMAN", "PAUSED", "CONTROLLED"].includes(mode)) {
      res.status(422).json({ error: "invalid_mode" });
      return;
    }
    const lead = await getLeadById(req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (mode === "HUMAN" || mode === "PAUSED") {
      abortPendingClientChat(lead.clientPhone, "crm_mode_change");
    }
    if (mode === "AUTO") {
      clearClientOutboundBlock(lead.clientPhone);
    }
    const updated = await updateLead(lead.leadId, {
      aiMode: mode,
      status: mode === "PAUSED" ? "paused" : lead.status === "paused" && mode === "AUTO" ? "new" : lead.status,
    });
    await addManagerInstruction(lead.leadId, { type: "SET_MODE", value: mode, source: "crm" });
    log("CRM MODE", { leadId: lead.leadId, aiMode: mode });
    res.json({ ok: true, lead: updated });
  });

  router.post("/leads/:leadId/messages", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      res.status(422).json({ error: "text_required" });
      return;
    }
    const lead = await getLeadById(req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const chatId = toChatId(lead.clientPhone);
    if (!chatId) {
      res.status(422).json({ error: "phone_required" });
      return;
    }
    const sent = await sendWhatsAppMessage(chatId, text);
    res.json({ ok: true, idMessage: sent?.idMessage || null, sender: "whatsappService.js" });
  });

  router.post("/leads/:leadId/instruction", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      res.status(422).json({ error: "text_required" });
      return;
    }
    const lead = await getLeadById(req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await addManagerInstruction(lead.leadId, {
      type: "ADD_INSTRUCTION",
      value: text,
      source: "crm",
    });
    log("CRM INSTRUCTION", { leadId: lead.leadId });
    res.json({ ok: true, leadId: lead.leadId });
  });

  return router;
}

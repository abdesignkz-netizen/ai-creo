import { extractPhoneCandidate, extractPhoneFromVcard } from "./phoneService.js";

export async function extractIncomingText(body) {
  const typeMessage = body?.messageData?.typeMessage || body?.typeMessage;
  const parts = [];

  if (typeMessage === "textMessage" || typeMessage === "text") {
    parts.push(
      body.messageData?.textMessageData?.textMessage || body.textMessage || "",
    );
  } else if (typeMessage === "extendedTextMessage") {
    const extra = body.messageData?.extendedTextMessageData || {};
    parts.push(extra.text || extra.description || extra.title || body.textMessage || "");
  } else if (typeMessage === "quotedMessage") {
    parts.push(body.messageData?.extendedTextMessageData?.text || "");
  } else if (typeMessage === "contactMessage") {
    const contact = body.messageData?.contactMessageData || {};
    const phone =
      extractPhoneFromVcard(contact.vcard) ||
      extractPhoneCandidate(contact.displayName || "");
    if (phone) parts.push(phone);
    if (contact.displayName) parts.push(contact.displayName);
  }

  const caption = body.messageData?.fileMessageData?.caption;
  if (caption) parts.push(caption);

  return parts.filter(Boolean).join("\n").trim();
}

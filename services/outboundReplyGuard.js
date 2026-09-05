const BOT_SELF_RE =
  /whatsapp\s+помощник|я\s+бот|чат-?бот|виртуальн\w+\s+помощник|со\s+мной\s+можно\s+общаться\s+с\s+помощью\s+команд/i;

const MENU_HINT_RE =
  /отправ(?:ьте|ь).{0,24}цифр|по\s+одной\s+цифре|пункт\s+меню|одну\s+цифру\s+от\s+\d/i;

const PLAY_ALONG_RE =
  /какой\s+пункт\s+вас\s+интересует|отправьте\s+одну\s+цифру\s+от\s+[1-8]|цифру\s+от\s+1\s+до\s+8/i;

export function isOutboundOriginLead(lead) {
  return ["manager_broadcast", "manager_outbound"].includes(String(lead?.source || ""));
}

export function countNumberedMenuLines(text) {
  return (String(text || "").match(/^\s*\d{1,2}[\.\)\:\-]\s+\S+/gm) || []).length;
}

export function looksLikeForeignWhatsAppMenu(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }

  const numbered = countNumberedMenuLines(value);
  const botSelf = BOT_SELF_RE.test(value);
  const menuHint = MENU_HINT_RE.test(value);

  if (numbered >= 4 && (botSelf || menuHint)) {
    return true;
  }
  if (botSelf && menuHint) {
    return true;
  }
  return false;
}

export function looksLikePlayingAlongWithForeignMenu(reply) {
  return PLAY_ALONG_RE.test(String(reply || ""));
}

export function shouldSkipForeignBotReply({ lead, incomingText, generatedReply }) {
  if (!isOutboundOriginLead(lead)) {
    return { skip: false };
  }

  if (looksLikeForeignWhatsAppMenu(incomingText)) {
    return { skip: true, reason: "foreign_bot_menu" };
  }

  if (generatedReply && looksLikePlayingAlongWithForeignMenu(generatedReply)) {
    return { skip: true, reason: "play_along_foreign_menu" };
  }

  return { skip: false };
}

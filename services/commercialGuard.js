const CATALOG_PRICES = new Set([
  50000, 100000, 150000, 180000, 210000, 240000, 270000, 300000,
]);

const COMMIT_RE =
  /под такой бюджет|за эти деньги|уложитьс|уложиться|можно рассмотреть|сделаем за|компактн\w* вариант|ориентир понял|как ориентир|зафиксировал.{0,40}\d|бюджет.{0,40}сдела|сдела.{0,40}бюджет|подтвержд|за \d[\d\s.]{2,}/i;

const PRICE_TALK_RE = /сколько\s+стоит|цен[аыу]|стоимост|прайс|тариф|пакет|кп\b|коммерческ/i;

export function parseMoneyAmounts(text) {
  const raw = String(text || "");
  const found = new Set();

  for (const match of raw.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:к|тыс\.?|тысяч)/gi)) {
    const value = Math.round(Number(String(match[1]).replace(",", ".")) * 1000);
    if (isPlausibleMoney(value)) {
      found.add(value);
    }
  }

  for (const match of raw.matchAll(/(?<![\d])(\d{1,3}(?:[\s.,]\d{3})+|\d{5,7})(?![\d])/g)) {
    const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
    if (isPlausibleMoney(value)) {
      found.add(value);
    }
  }

  return [...found];
}

function isPlausibleMoney(value) {
  if (!Number.isFinite(value) || value < 10000 || value > 20000000) {
    return false;
  }
  if (value >= 1900 && value <= 2099) {
    return false;
  }
  return value % 1000 === 0;
}

export function isApprovedPrice(amount, lead = {}) {
  const value = Number(amount);
  if (!value) {
    return false;
  }
  if (CATALOG_PRICES.has(value)) {
    return true;
  }
  if (lead.minPrice && value === Number(lead.minPrice)) {
    return true;
  }
  return false;
}

export function extractCustomBudgets(text, lead = {}) {
  return parseMoneyAmounts(text).filter((amount) => !isApprovedPrice(amount, lead));
}

const EXTRA_SLIDE_RE =
  /(?:ещ[её]|дополнительн(?:ый|ых|о|ые)?|добав(?:им|ить|ьте|лю)?(?:\s+ещ[её])?|плюс|\+)\s*(\d{1,2})\s*слайд/gi;
const TARGET_SLIDE_RE = /(\d{1,2})\s*слайд\w*\s+под\s+(?:таргет|реклам|кампан)/gi;
const RANGE_SLIDE_RE = /(\d{1,2})\s*[–\-—]\s*(\d{1,2})\s*слайд/gi;
const UP_TO_SLIDE_RE = /до\s*(10|15)\s*слайд/gi;
const ABSOLUTE_SLIDE_RE = /(\d{1,2})\s*слайд/gi;
const EXTRA_SLIDE_TALK_RE =
  /(?:ещ[её]|дополнительн\w*|добав\w*|плюс|\+)\s*(?:\d{1,2}\s*)?слайд|доплат\w*.{0,24}слайд|слайд.{0,24}доплат/i;

function spansOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(raw, regex, pick) {
  const matches = [];
  regex.lastIndex = 0;
  for (const match of raw.matchAll(regex)) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      value: pick(match),
    });
  }
  return matches.filter((item) => Number.isFinite(item.value) && item.value > 0);
}

function withoutOverlaps(candidates, blocked) {
  return candidates.filter((item) => !blocked.some((span) => spansOverlap(item, span)));
}

export function parseSlideMention(text) {
  const raw = String(text || "");
  const extras = [
    ...collectMatches(raw, EXTRA_SLIDE_RE, (match) => Number(match[1])),
    ...collectMatches(raw, TARGET_SLIDE_RE, (match) => Number(match[1])),
  ];
  const extraSpans = [];
  const extraValues = [];
  for (const item of extras) {
    if (extraSpans.some((span) => spansOverlap(item, span))) {
      continue;
    }
    extraSpans.push(item);
    extraValues.push(item.value);
  }

  const absolutes = [
    ...collectMatches(raw, RANGE_SLIDE_RE, (match) => Number(match[2])),
    ...collectMatches(raw, UP_TO_SLIDE_RE, (match) => Number(match[1])),
    ...withoutOverlaps(
      collectMatches(raw, ABSOLUTE_SLIDE_RE, (match) => Number(match[1])),
      extraSpans,
    ),
  ];
  const absolute = withoutOverlaps(absolutes, extraSpans).at(-1)?.value ?? null;
  const extra = extraValues.length ? extraValues.reduce((sum, value) => sum + value, 0) : null;

  return {
    absolute,
    extra,
    total: absolute != null ? absolute + (extra || 0) : null,
  };
}

export function extractSlideCount(text) {
  const mention = parseSlideMention(text);
  if (mention.total != null) {
    return mention.total;
  }
  return null;
}

function findLastAbsoluteSlideCount({ message, history = [], lead = {}, skipMessage = false }) {
  const sources = [];
  if (!skipMessage && message) {
    sources.push(message);
  }
  const recent = (Array.isArray(history) ? history : [])
    .filter((item) => item?.content)
    .slice(-10)
    .reverse()
    .map((item) => item.content);
  sources.push(...recent);
  if (lead.lastClientMessage) {
    sources.push(lead.lastClientMessage);
  }
  if (lead.requestSummary) {
    sources.push(lead.requestSummary);
  }

  for (const content of sources) {
    const mention = parseSlideMention(content);
    if (mention.total != null) {
      return mention.total;
    }
  }

  return null;
}

export function classifyPresentationVolume(count) {
  if (!count) {
    return "unknown";
  }
  if (count < 10) {
    return "small";
  }
  if (count <= 15) {
    return "standard";
  }
  return "oversize";
}

function contextTexts({ message, history = [], lead = {} }) {
  return [
    message,
    lead.requestSummary,
    lead.lastClientMessage,
    ...(Array.isArray(history) ? history : []).map((item) => item?.content),
  ]
    .filter(Boolean)
    .join("\n");
}

export function looksLikePresentation({ message, history = [], lead = {} }) {
  if (lead.service === "presentation") {
    return true;
  }
  return /презентац|слайд/i.test(contextTexts({ message, history, lead }));
}

export function presentationVolumeFromContext(args) {
  const current = parseSlideMention(args.message);
  const extraTalk = EXTRA_SLIDE_TALK_RE.test(String(args.message || ""));
  const base = findLastAbsoluteSlideCount({
    ...args,
    skipMessage: true,
  });

  if (current.total != null) {
    return classifyPresentationVolume(current.total);
  }

  if (current.extra != null && base != null) {
    return classifyPresentationVolume(base + current.extra);
  }

  if (extraTalk) {
    if (current.extra != null) {
      return "unknown";
    }
    return "oversize";
  }

  if (base != null) {
    return classifyPresentationVolume(base);
  }

  return "unknown";
}

export function customBudgetsFromContext({ message, history = [], lead = {} }) {
  const fromMessage = extractCustomBudgets(message, lead);
  if (fromMessage.length) {
    return fromMessage;
  }

  const recentUsers = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user" && item?.content)
    .slice(-6)
    .reverse();

  for (const item of recentUsers) {
    const amounts = extractCustomBudgets(item.content, lead);
    if (amounts.length) {
      return amounts;
    }
  }

  return [];
}

export function commercialGuardInstruction(amounts, volume = "unknown", isPresentation = false) {
  const parts = [];

  if (volume === "small") {
    parts.push(
      "Объём меньше 10 слайдов: можно назвать только цены из прайса по комплектации.",
      "Другие цифры, «сделаем за эти деньги» и подтверждение бюджета клиента запрещены.",
    );
  } else if (volume === "oversize") {
    parts.push(
      "Объём больше 15 слайдов. Прайсовые пакеты — только до 10 и до 15 слайдов. Доп. слайды не оценивай сам.",
      "manager_event=decision_required.",
    );
  } else if (volume === "standard") {
    parts.push(
      "Объём около 10–15 слайдов: можно назвать только цены из КП или отправить КП.",
      "Пакеты до 10 слайдов: PDF 150 000 ₸, DESIGN 180 000 ₸, BUSINESS 210 000 ₸ (рекомендуем), FULL 240 000 ₸.",
      "До 15 слайдов: PDF 210 000 ₸, DESIGN 240 000 ₸, BUSINESS 270 000 ₸, FULL 300 000 ₸.",
      "Другие цифры не выдумывай.",
    );
  } else if (isPresentation) {
    parts.push(
      "Если это презентация и объём неясен — уточни, ориентир до 10 или до 15 слайдов. Не называй цену за 5–6 слайдов.",
    );
  }

  if (amounts.length) {
    const listed = amounts.map((amount) => `${amount.toLocaleString("ru-RU")} ₸`).join(", ");
    parts.push(
      `Клиент назвал свою сумму: ${listed}. Это не цена из прайса.`,
      "Не повторяй эту цифру клиенту. Не пиши «ориентир принял», «сделаем за эти деньги», «под такой бюджет».",
      "manager_event=decision_required.",
      "Клиенту: свою сумму сам не подтверждаю, могу назвать только цены из прайса.",
    );
  }

  if (!parts.length) {
    return "";
  }

  parts.push("Клиенту нельзя писать, что передаёшь менеджеру.");
  return parts.join(" ");
}

function formatAmount(amount) {
  return `${Number(amount).toLocaleString("ru-RU")} ₸`;
}

export function buildSafeCommercialReply(_amount, volume = "unknown", namedByClient = false) {
  if (volume === "small") {
    return [
      "Назвать могу только цены из прайса CREOLAB по выбранной комплектации.",
      "Пришлите материалы и задачу — сориентирую по пакету.",
    ].join(" ");
  }

  if (volume === "oversize") {
    return [
      "Пакеты из прайса покрывают до 15 слайдов, всё что больше считаем отдельно.",
      "Пришлите материалы и задачу — согласуем формат.",
    ].join(" ");
  }

  if (namedByClient) {
    return [
      "Свою сумму сам не подтверждаю и пакет под неё не подстраиваю.",
      "Могу назвать только цены из прайса CREOLAB либо согласуем отдельно.",
    ].join(" ");
  }

  return [
    "Стоимость называю только по прайсу CREOLAB, другие цифры не подтверждаю.",
    "Напишите объём задачи — сориентирую по пакету.",
  ].join(" ");
}

export function shouldSendPresentationKp({
  message,
  history = [],
  lead = {},
  volume,
  blocked,
}) {
  if (blocked || volume !== "standard") {
    return false;
  }
  if (!looksLikePresentation({ message, history, lead })) {
    return false;
  }

  const asked = PRICE_TALK_RE.test(String(message || ""));
  const askedBefore = (Array.isArray(history) ? history : []).some(
    (item) => item?.role === "user" && PRICE_TALK_RE.test(String(item.content || "")),
  );
  return asked || askedBefore;
}

export function applyCommercialGuard({
  message,
  reply,
  result = {},
  lead = {},
  history = [],
}) {
  const custom = customBudgetsFromContext({ message, history, lead });
  const invented = extractCustomBudgets(reply, lead);
  const volume = looksLikePresentation({ message, history, lead })
    ? presentationVolumeFromContext({ message, history, lead })
    : "unknown";
  const commits =
    COMMIT_RE.test(reply) ||
    (custom.length > 0 && /сделаем за|под такой бюджет|компактн|подстрою/i.test(reply));
  const needsDecision =
    custom.length > 0 ||
    invented.length > 0 ||
    volume === "oversize";

  if (!needsDecision) {
    return {
      reply,
      result: {
        ...result,
        budget: approvedBudgetOrEmpty(result.budget, lead),
      },
      blocked: false,
      amounts: [],
      volume,
    };
  }

  const unsafe =
    commits ||
    invented.length > 0 ||
    /подстрою|комфортн\w* бюджет|что реально сделать за|ориентир принял/i.test(reply) ||
    (volume === "oversize" && /₸|тенге|стоим|зафиксир/i.test(reply));

  const nextReply = unsafe
    ? buildSafeCommercialReply(custom[0] || null, volume, custom.length > 0)
    : reply;
  const note = [
    volume === "oversize"
      ? "Объём больше 15 слайдов — доп. слайды и цену должен подтвердить менеджер."
      : custom.length
        ? `Клиент назвал свою сумму ${formatAmount(custom[0])}.`
        : invented.length
          ? "Модель назвала цифру не из прайса."
          : "Нестандартные коммерческие условия.",
    "AI не должен подтверждать чужой бюджет, скидку или выдуманную цену.",
    custom.length || invented.length || volume === "oversize"
      ? "Нужно решение живого менеджера."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    reply: nextReply,
    result: {
      ...result,
      budget: custom[0] ? String(custom[0]) : approvedBudgetOrEmpty(result.budget, lead),
      manager_event:
        custom.length || invented.length || volume === "oversize"
          ? "decision_required"
          : result.manager_event,
      manager_event_note: unsafe ? note : result.manager_event_note,
    },
    blocked: unsafe,
    amounts: custom,
    volume,
  };
}

function approvedBudgetOrEmpty(value, lead) {
  return isApprovedPrice(value, lead) ? String(value) : "";
}

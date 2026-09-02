const CATALOG_PRICES = new Set([
  50000, 100000, 150000, 180000, 210000, 240000, 270000, 300000,
]);

const COMMIT_RE =
  /под такой бюджет|за эти деньги|уложитьс|уложиться|можно рассмотреть|сделаем за|компактн\w* вариант|ориентир понял|как ориентир|зафиксировал.{0,40}\d|бюджет.{0,40}сдела|сдела.{0,40}бюджет|подтвержд|за \d[\d\s.]{2,}/i;

const PACKAGE_RE = /слайд|полный объ[её]м|под ключ за|сделаем за|компактн/i;

const PRICE_TALK_RE = /сколько\s+стоит|цен[аыу]|стоимост|прайс|тариф|пакет|кп\b|коммерческ/i;

export function parseMoneyAmounts(text) {
  const raw = String(text || "");
  const found = new Set();

  for (const match of raw.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:к|тыс\.?|тысяч)/gi)) {
    const value = Math.round(Number(String(match[1]).replace(",", ".")) * 1000);
    if (value >= 1000 && value <= 20000000) {
      found.add(value);
    }
  }

  for (const match of raw.matchAll(/(?<![\d])(\d{1,3}(?:[\s.,]\d{3})+|\d{4,7})(?![\d])/g)) {
    const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
    if (value >= 1000 && value <= 20000000) {
      found.add(value);
    }
  }

  return [...found];
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

export function extractSlideCount(text) {
  const raw = String(text || "");
  let count = null;

  const range = raw.match(/(\d{1,2})\s*[–\-—]\s*(\d{1,2})\s*слайд/i);
  if (range) {
    count = Number(range[2]);
  } else if (/до\s*15\s*слайд/i.test(raw)) {
    count = 15;
  } else if (/до\s*10\s*слайд/i.test(raw)) {
    count = 10;
  } else {
    const single = raw.match(/(\d{1,2})\s*слайд/i);
    if (single) {
      count = Number(single[1]);
    }
  }

  const extra = raw.match(/\+\s*(\d{1,2})\s*слайд/i);
  if (count && extra) {
    count += Number(extra[1]);
  }

  return count;
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
  const fromMessage = extractSlideCount(args.message);
  if (fromMessage) {
    return classifyPresentationVolume(fromMessage);
  }

  const recent = (Array.isArray(args.history) ? args.history : [])
    .filter((item) => item?.content)
    .slice(-10)
    .reverse();
  for (const item of recent) {
    const count = extractSlideCount(item.content);
    if (count) {
      return classifyPresentationVolume(count);
    }
  }

  return classifyPresentationVolume(extractSlideCount(contextTexts(args)));
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

  return extractCustomBudgets(lead.budget, lead);
}

export function commercialGuardInstruction(amounts, volume = "unknown", isPresentation = false) {
  const parts = [];

  if (volume === "small") {
    parts.push(
      "Объём презентации меньше 10 слайдов (например 5–6 + таргет). Цену не называй, пакет не подстраивай, «сделаем за эти деньги» запрещено.",
      "manager_event=decision_required.",
      "Клиенту: такой объём считаем отдельно, сразу стоимость не подтверждаю.",
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
      `Клиент назвал свою сумму: ${listed}. Это не цена из КП.`,
      "Запрещено подтверждать объём, пакет, скидку или «компактный вариант» под эти деньги.",
      "manager_event=decision_required.",
      "Клиенту: ориентир принял, объём и точную стоимость сам не подтверждаю, согласуем отдельно.",
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

export function buildSafeCommercialReply(amount, volume = "unknown") {
  if (volume === "small") {
    return [
      "Такой объём — меньше 10 слайдов — считаем отдельно, сразу стоимость не подтверждаю.",
      "Пришлите материалы и задачу, согласуем формат.",
    ].join(" ");
  }

  const label = amount ? formatAmount(amount) : "этот бюджет";
  return [
    `${label} как ориентир принял.`,
    "Объём работ и точную стоимость по такой сумме сам не подтверждаю — это согласуем отдельно.",
    "Можете прислать материалы, продолжим по задаче.",
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
  const commits = COMMIT_RE.test(reply) || (custom.length > 0 && PACKAGE_RE.test(reply));
  const quotedCatalogOnSmall =
    volume === "small" && parseMoneyAmounts(reply).some((amount) => isApprovedPrice(amount, lead));
  const needsDecision =
    custom.length > 0 ||
    (invented.length > 0 && commits) ||
    volume === "small" ||
    volume === "oversize";

  if (!needsDecision) {
    return { reply, result, blocked: false, amounts: [], volume };
  }

  const amount = custom[0] || invented[0] || null;
  const unsafe =
    commits ||
    invented.length > 0 ||
    quotedCatalogOnSmall ||
    /подстрою|комфортн\w* бюджет|что реально сделать за/i.test(reply) ||
    ((volume === "small" || volume === "oversize") &&
      (/₸|тенге|стоим|пакет|зафиксир/i.test(reply) || commits));

  const nextReply = unsafe ? buildSafeCommercialReply(amount, volume) : reply;
  const note = [
    volume === "small"
      ? "Объём презентации меньше 10 слайдов — цену должен сказать живой менеджер."
      : volume === "oversize"
        ? "Объём больше 15 слайдов — доп. слайды и цену должен подтвердить менеджер."
        : amount
          ? `Клиент назвал ${formatAmount(amount)}.`
          : "Нестандартные коммерческие условия.",
    "AI не должен подтверждать объём, скидку или свою цену.",
    "Нужно решение живого менеджера.",
  ].join(" ");

  return {
    reply: nextReply,
    result: {
      ...result,
      budget: amount ? String(amount) : result.budget,
      manager_event: "decision_required",
      manager_event_note: note,
    },
    blocked: unsafe,
    amounts: custom.length ? custom : invented,
    volume,
  };
}

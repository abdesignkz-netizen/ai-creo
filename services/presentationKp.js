const PRICE_TALK_RE = /сколько\s+стоит|цен[аыу]|стоимост|прайс|тариф|пакет|кп\b|коммерческ/i;

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

export function shouldSendPresentationKp({
  message,
  history = [],
  lead = {},
  volume,
}) {
  if (volume !== "standard") {
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

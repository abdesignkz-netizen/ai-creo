const TIME_ZONE = "Asia/Almaty";

function almatyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);

  const get = (type) => parts.find((item) => item.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function zonedDate({ year, month, day, hour = 0, minute = 0, second = 0, ms = 0 }) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const asAlmaty = almatyParts(new Date(utcGuess));
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const got = Date.UTC(
    asAlmaty.year,
    asAlmaty.month - 1,
    asAlmaty.day,
    asAlmaty.hour,
    asAlmaty.minute,
    asAlmaty.second,
  );
  return new Date(utcGuess + (wanted - got));
}

function addAlmatyDays(date, days) {
  const parts = almatyParts(date);
  return zonedDate({
    year: parts.year,
    month: parts.month,
    day: parts.day + days,
    hour: 0,
    minute: 0,
    second: 0,
  });
}

export function endOfAlmatyDay(date = new Date()) {
  const parts = almatyParts(date);
  return zonedDate({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 23,
    minute: 59,
    second: 59,
    ms: 999,
  });
}

export function startOfAlmatyDay(date = new Date()) {
  const parts = almatyParts(date);
  return zonedDate({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
}

export function endOfAlmatyWeek(date = new Date()) {
  const parts = almatyParts(date);
  const weekIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const daysUntilSunday = weekIndex === 0 ? 0 : 7 - weekIndex;
  return endOfAlmatyDay(addAlmatyDays(date, daysUntilSunday));
}

export function parseBudgetAmount(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || text === "не выяснено" || text === "unknown") {
    return null;
  }

  const million = text.match(/(\d+(?:[.,]\d+)?)\s*(млн|миллион)/i);
  if (million) {
    return Math.round(Number(million[1].replace(",", ".")) * 1_000_000);
  }

  const thousand = text.match(/(\d+(?:[.,]\d+)?)\s*(тыс|тысяч)/i);
  if (thousand) {
    return Math.round(Number(thousand[1].replace(",", ".")) * 1_000);
  }

  const digits = text.replace(/[^\d]/g, "");
  if (!digits) {
    return null;
  }
  return Number(digits);
}

export function formatBudgetLabel(amount) {
  if (!Number.isFinite(amount)) {
    return "";
  }
  if (amount >= 1_000_000 && amount % 100_000 === 0) {
    const mln = amount / 1_000_000;
    return `${String(mln).replace(".", ",")} млн`;
  }
  return `${amount.toLocaleString("ru-RU")} ₸`;
}

export function parseValidityPeriod(message, now = new Date()) {
  const text = String(message || "").toLowerCase();
  const validFrom = now.toISOString();

  if (/пока\s+я\s+не\s+скажу|пока\s+не\s+отмен|до\s+отмены|постоянн/i.test(text)) {
    return { validFrom, validUntil: null, periodLabel: "пока не отменю" };
  }

  if (/только\s+сейчас|разово|следующ(ее|ее)\s+сообщен/i.test(text)) {
    return {
      validFrom,
      validUntil: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      periodLabel: "только сейчас",
    };
  }

  const hours = text.match(/следующ(?:ие|их)?\s+(\d+)\s+час/i);
  if (hours) {
    const until = new Date(now.getTime() + Number(hours[1]) * 60 * 60 * 1000);
    return { validFrom, validUntil: until.toISOString(), periodLabel: `следующие ${hours[1]} ч` };
  }

  const untilHour = text.match(/до\s+(\d{1,2})(?::(\d{2}))/);
  const untilHourLoose = text.match(/до\s+(\d{1,2})\s*(?:час|:00)?(?:\s|$|[.,!])/);
  const clock = untilHour || (untilHourLoose && !/до\s+конца|до\s+завтра/i.test(text) ? untilHourLoose : null);
  if (clock && !/до\s+конца\s+(дня|недели)/i.test(text)) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    if (hour >= 0 && hour <= 23) {
      const parts = almatyParts(now);
      let point = zonedDate({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour,
        minute,
        second: 0,
      });
      if (point.getTime() <= now.getTime()) {
        point = zonedDate({
          year: parts.year,
          month: parts.month,
          day: parts.day + 1,
          hour,
          minute,
          second: 0,
        });
      }
      return {
        validFrom,
        validUntil: point.toISOString(),
        periodLabel: `до ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      };
    }
  }

  if (/до\s+конца\s+недели|на\s+этой\s+неделе/i.test(text)) {
    return {
      validFrom,
      validUntil: endOfAlmatyWeek(now).toISOString(),
      periodLabel: "до конца недели",
    };
  }

  if (/до\s+завтра/i.test(text)) {
    return {
      validFrom,
      validUntil: startOfAlmatyDay(addAlmatyDays(now, 1)).toISOString(),
      periodLabel: "до завтра",
    };
  }

  if (/завтра/i.test(text) && !/после\s+\d/i.test(text)) {
    return {
      validFrom,
      validUntil: endOfAlmatyDay(addAlmatyDays(now, 1)).toISOString(),
      periodLabel: "завтра",
    };
  }

  if (/сегодня|до\s+конца\s+дня|на\s+сегодня/i.test(text)) {
    return {
      validFrom,
      validUntil: endOfAlmatyDay(now).toISOString(),
      periodLabel: "сегодня",
    };
  }

  return { validFrom, validUntil: null, periodLabel: "пока не отменю" };
}

export function isInstructionExpired(instruction, now = new Date()) {
  if (!instruction?.validUntil) {
    return false;
  }
  return new Date(instruction.validUntil).getTime() <= now.getTime();
}

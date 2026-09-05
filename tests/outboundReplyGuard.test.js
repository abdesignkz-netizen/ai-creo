import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeForeignWhatsAppMenu,
  looksLikePlayingAlongWithForeignMenu,
  shouldSkipForeignBotReply,
} from "../services/outboundReplyGuard.js";

const starkovaMenu = [
  "Привет. На связи WhatsApp помощник Starkova express beauty studio, со мной можно общаться с помощью команд. Отправляйте по одной цифре 👇:",
  "1. Информация о нас",
  "2. Стоимость",
  "3. Акции",
  "4. Онлайн запись",
  "5. Подключить администратора к диалогу",
  "6. Заказать обратный звонок",
  "7. Отмена записи",
  "8. Наш адрес",
].join("\n");

test("Starkova-style bot menu is detected", () => {
  assert.equal(looksLikeForeignWhatsAppMenu(starkovaMenu), true);
});

test("a real salon intro is not treated as a foreign bot menu", () => {
  const mika =
    "Приветствую! Я Мика, мастер с опытом работы более 10 лет. MS mono studio по наращиванию ресниц принимает только по предварительной записи. Предоплата 2000 тенге.";
  assert.equal(looksLikeForeignWhatsAppMenu(mika), false);
});

test("inbound ordinary chats are not skipped", () => {
  const decision = shouldSkipForeignBotReply({
    lead: { source: "inbound" },
    incomingText: starkovaMenu,
  });
  assert.equal(decision.skip, false);
});

test("broadcast lead + bot menu skips the AI reply", () => {
  const decision = shouldSkipForeignBotReply({
    lead: { source: "manager_broadcast" },
    incomingText: starkovaMenu,
  });
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "foreign_bot_menu");
});

test("generated play-along reply is blocked after outbound", () => {
  const decision = shouldSkipForeignBotReply({
    lead: { source: "manager_broadcast" },
    incomingText: "1",
    generatedReply: "Здравствуйте! Какой пункт Вас интересует? Отправьте одну цифру от 1 до 8.",
  });
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "play_along_foreign_menu");
  assert.equal(
    looksLikePlayingAlongWithForeignMenu(
      "Здравствуйте! Какой пункт Вас интересует? Отправьте одну цифру от 1 до 8.",
    ),
    true,
  );
});

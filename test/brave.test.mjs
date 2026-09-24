import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBraveSearchUrl,
  mapBraveResults,
  normalizeBraveCountry,
  normalizeBraveSearchLang,
  normalizeBraveUiLang,
  searchBrave,
} from "../src/brave.ts";
import { BRAVE, collectLogger, createFakeFetch, fixture, jsonResponse, textResponse } from "./helpers.mjs";

const baseParams = { query: "МТС новости", count: 10, timeoutMs: 5000 };

test("buildBraveSearchUrl: параметры, свежесть и диапазоны дат", () => {
  const plain = buildBraveSearchUrl(baseParams, "2026-09-24");
  assert.equal(plain.searchParams.get("q"), "МТС новости");
  assert.equal(plain.searchParams.get("count"), "10");
  assert.equal(plain.searchParams.get("text_decorations"), "false");
  assert.equal(plain.searchParams.get("freshness"), null);
  assert.equal(plain.searchParams.get("country"), null);

  const filtered = buildBraveSearchUrl({ ...baseParams, count: 50, country: "ru", language: "ru", freshness: "pw", uiLang: "ru_RU" }, "2026-09-24");
  assert.equal(filtered.searchParams.get("count"), "20");
  assert.equal(filtered.searchParams.get("country"), "RU");
  assert.equal(filtered.searchParams.get("search_lang"), "ru");
  assert.equal(filtered.searchParams.get("ui_lang"), "ru-RU");
  assert.equal(filtered.searchParams.get("freshness"), "pw");

  assert.equal(buildBraveSearchUrl({ ...baseParams, dateAfter: "2026-09-01" }, "2026-09-24").searchParams.get("freshness"), "2026-09-01to2026-09-24");
  assert.equal(buildBraveSearchUrl({ ...baseParams, dateBefore: "2026-09-10" }, "2026-09-24").searchParams.get("freshness"), "1970-01-01to2026-09-10");
  assert.equal(
    buildBraveSearchUrl({ ...baseParams, dateAfter: "2026-09-01", dateBefore: "2026-09-10" }, "2026-09-24").searchParams.get("freshness"),
    "2026-09-01to2026-09-10",
  );
  assert.equal(buildBraveSearchUrl({ ...baseParams, searchLang: "en-gb", language: "ru" }).searchParams.get("search_lang"), "en-gb");
});

test("нормализация страны и языков Brave", () => {
  assert.equal(normalizeBraveCountry("de"), "DE");
  assert.equal(normalizeBraveCountry("XX"), "ALL");
  assert.equal(normalizeBraveCountry(""), undefined);
  assert.equal(normalizeBraveSearchLang("ja"), "jp");
  assert.equal(normalizeBraveSearchLang("zh-TW"), "zh-hant");
  assert.equal(normalizeBraveSearchLang("xx"), undefined);
  assert.equal(normalizeBraveUiLang("en-us"), "en-US");
  assert.equal(normalizeBraveUiLang("en"), undefined);
});

test("mapBraveResults: формат ядра, дата из page_age, hostname из meta_url, без URL отброшено", () => {
  const rows = mapBraveResults(JSON.parse(fixture("brave-ok.json")));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    title: "МТС запускает сеть 5G",
    url: "https://moskva.mts.ru/personal/novosti/2026-09-11/mts-zapuskaet-setj-5g",
    snippet: '11 сентября "МТС" открыла свободный доступ к сети Супер 5G со скоростью до 1,5 Гбит/с в пяти крупных городах и запустила сеть 5G.',
    published: "2026-09-11",
    siteName: "moskva.mts.ru",
  });
  assert.equal(rows[1].published, "2026-09-18");
  assert.equal(rows[1].siteName, "www.mts.by");
});

test("searchBrave: успех, одна повторная попытка после 429, ошибка при 401", async () => {
  const ok = createFakeFetch([{ match: BRAVE, handle: () => jsonResponse(JSON.parse(fixture("brave-ok.json"))) }]);
  const rows = await searchBrave(baseParams, { apiKey: "brave-key", fetchImpl: ok.fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(ok.calls[0].init.headers["X-Subscription-Token"], "brave-key");

  const { logger, lines } = collectLogger();
  const limited = createFakeFetch([
    {
      match: BRAVE,
      handle: (_u, _i, call) =>
        call === 1 ? textResponse("rate limited", { status: 429, headers: { "retry-after": "1" } }) : jsonResponse(JSON.parse(fixture("brave-ok.json"))),
    },
  ]);
  const retried = await searchBrave(baseParams, { apiKey: "k", fetchImpl: limited.fetchImpl, logger, retryDelayMs: 1 });
  assert.equal(retried.length, 2);
  assert.equal(limited.calls.length, 2);
  assert.equal(lines.debug.length, 1);

  const unauthorized = createFakeFetch([{ match: BRAVE, handle: () => textResponse('{"type":"ErrorResponse"}', { status: 401 }) }]);
  await assert.rejects(
    searchBrave(baseParams, { apiKey: "bad", fetchImpl: unauthorized.fetchImpl }),
    (err) => err.name === "EngineError" && err.status === 401,
  );
});

test("searchBrave: сетевая ошибка и таймаут", async () => {
  const network = createFakeFetch([{ match: BRAVE, handle: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") })) }]);
  await assert.rejects(
    searchBrave(baseParams, { apiKey: "k", fetchImpl: network.fetchImpl }),
    (err) => err.name === "EngineError" && /ECONNRESET/.test(err.message),
  );

  const slow = createFakeFetch([
    {
      match: BRAVE,
      handle: (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    },
  ]);
  await assert.rejects(
    searchBrave({ ...baseParams, timeoutMs: 30 }, { apiKey: "k", fetchImpl: slow.fetchImpl }),
    (err) => err.name === "EngineError" && /таймаут/.test(err.message),
  );
});

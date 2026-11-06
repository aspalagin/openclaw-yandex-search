import test from "node:test";
import assert from "node:assert/strict";
import {
  buildYandexRequestBody,
  parseYandexXml,
  resolveYandexLocalization,
  resolveYandexMode,
  resolveYandexPeriod,
  resolveYandexSearchType,
  searchYandex,
} from "../src/yandex.ts";
import {
  YANDEX_ASYNC,
  YANDEX_OPS,
  YANDEX_SYNC,
  collectLogger,
  createFakeFetch,
  fastYandex,
  fixture,
  jsonResponse,
  textResponse,
  yandexOperation,
  yandexSyncResponse,
} from "./helpers.mjs";

const RATE_LIMITED = '{"code":8,"message":"search rate limit exceeded, retry later"}';

const baseParams = { query: "МТС новости сентябрь 2026", count: 10, timeoutMs: 5000 };
const creds = { apiKey: "test-key", folderId: "folder-1" };

test("parseYandexXml: строки в формате ядра, hlword и сущности убраны, не-http отброшен", () => {
  const { rows, error } = parseYandexXml(fixture("yandex-ok.xml"));
  assert.equal(error, undefined);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    title: "МТС запускает сеть 5G & Супер 5G | 11 сентября 2026",
    url: "https://moskva.mts.ru/personal/novosti/2026-09-11/mts-zapuskaet-setj-5g?utm_source=test",
    snippet: "11 сентября мы первыми в России открыли свободный доступ к сети Супер 5G. … Сеть 5G запущена в пяти крупных городах.",
    published: "2026-09-11",
    siteName: "moskva.mts.ru",
  });
  assert.equal(rows[1].title, "Дивиденды МТС: новая политика");
  assert.equal(rows[1].published, "2026-09-16");
  assert.equal(rows[1].siteName, "www.rbc.ru");
});

test("parseYandexXml: код 15 и прочие ошибки распознаются", () => {
  const empty = parseYandexXml(fixture("yandex-error-15.xml"));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.error.code, "15");

  const limit = parseYandexXml(fixture("yandex-error-32.xml"));
  assert.equal(limit.error.code, "32");
  assert.match(limit.error.message, /лимит/);

  const broken = parseYandexXml("<html>not xml</html>");
  assert.deepEqual(broken.rows, []);
  assert.match(broken.error.message, /yandexsearch\.response/);
});

test("buildYandexRequestBody: поле l10n, регион только для RU, период по фильтру", () => {
  const ru = buildYandexRequestBody({ query: "  тест  ", count: 10, folderId: "f", searchType: "SEARCH_TYPE_RU", localization: "LOCALIZATION_RU" });
  assert.equal(ru.query.queryText, "тест");
  assert.equal(ru.l10n, "LOCALIZATION_RU");
  assert.equal(ru.l10N, undefined);
  assert.equal(ru.region, "213");
  assert.equal(ru.responseFormat, "FORMAT_XML");
  assert.equal(ru.groupSpec.groupsOnPage, 10);
  assert.equal("period" in ru, false);

  const com = buildYandexRequestBody({ query: "x".repeat(500), count: 300, folderId: "f", searchType: "SEARCH_TYPE_COM", localization: "LOCALIZATION_EN", period: "PERIOD_DAY" });
  assert.equal(com.query.queryText.length, 400);
  assert.equal(com.region, undefined);
  assert.equal(com.period, "PERIOD_DAY");
  assert.equal(com.groupSpec.groupsOnPage, 100);
});

test("страна и язык → searchType и l10n", () => {
  assert.equal(resolveYandexSearchType(undefined), "SEARCH_TYPE_RU");
  assert.equal(resolveYandexSearchType("ru"), "SEARCH_TYPE_RU");
  assert.equal(resolveYandexSearchType("KZ"), "SEARCH_TYPE_KK");
  assert.equal(resolveYandexSearchType("US"), "SEARCH_TYPE_COM");
  assert.equal(resolveYandexSearchType("ALL"), "SEARCH_TYPE_COM");
  assert.equal(resolveYandexLocalization(undefined, "SEARCH_TYPE_RU"), "LOCALIZATION_RU");
  assert.equal(resolveYandexLocalization("en-US", "SEARCH_TYPE_RU"), "LOCALIZATION_EN");
  assert.equal(resolveYandexLocalization("de", "SEARCH_TYPE_COM"), "LOCALIZATION_EN");
});

test("resolveYandexPeriod: свежесть и диапазоны дат", () => {
  const now = new Date("2026-09-24T02:00:00Z");
  assert.deepEqual(resolveYandexPeriod({ freshness: "pd", now }), { period: "PERIOD_DAY", coverage: "exact" });
  assert.equal(resolveYandexPeriod({ freshness: "pw", now }).period, "PERIOD_2_WEEKS");
  assert.equal(resolveYandexPeriod({ freshness: "pm", now }).period, "PERIOD_MONTH");
  assert.equal(resolveYandexPeriod({ freshness: "py", now }).coverage, "none");
  assert.deepEqual(resolveYandexPeriod({ now }), { coverage: "exact" });
  // Сегодняшняя дата укладывается в сутки; вчерашняя уже нет (26 часов), поэтому берётся период-надмножество.
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-24", now }).period, "PERIOD_DAY");
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-23", now }).period, "PERIOD_2_WEEKS");
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-15", now }).period, "PERIOD_2_WEEKS");
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-01", now }).period, "PERIOD_MONTH");
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-06-01", now }).coverage, "none");
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-01", dateBefore: "2026-09-10", now }).coverage, "none");
  // Верхняя граница в будущем не ограничивает: считается только нижняя.
  assert.equal(resolveYandexPeriod({ dateAfter: "2026-09-20", dateBefore: "2026-09-30", now }).period, "PERIOD_2_WEEKS");
  assert.equal(resolveYandexPeriod({ dateBefore: "2026-12-31", now }).coverage, "exact");
});

test("searchYandex: запуск, опрос до done, разбор XML, тело запроса", async () => {
  const xml = fixture("yandex-ok.xml");
  const { fetchImpl, calls } = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-1", done: false }) },
    { match: YANDEX_OPS, handle: (_u, _i, call) => jsonResponse(call < 3 ? yandexOperation(xml, { done: false }) : yandexOperation(xml)) },
  ]);
  const rows = await searchYandex({ ...baseParams, country: "US", language: "en" }, { ...creds, ...fastYandex, fetchImpl, period: "PERIOD_DAY" });
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 4);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.headers.Authorization, "Api-Key test-key");
  assert.equal(body.query.searchType, "SEARCH_TYPE_COM");
  assert.equal(body.l10n, "LOCALIZATION_EN");
  assert.equal(body.period, "PERIOD_DAY");
  assert.equal(body.folderId, "folder-1");
  assert.ok(calls[1].url.startsWith(`${YANDEX_OPS}op-1`));
});

test("searchYandex: код 15 → пустая выдача, код 32 → ошибка", async () => {
  const make = (xml) =>
    createFakeFetch([
      { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-2" }) },
      { match: YANDEX_OPS, handle: () => jsonResponse(yandexOperation(xml)) },
    ]).fetchImpl;
  assert.deepEqual(await searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: make(fixture("yandex-error-15.xml")) }), []);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: make(fixture("yandex-error-32.xml")) }),
    (err) => err.name === "EngineError" && /код 32/.test(err.message),
  );
});

test("searchYandex: HTTP-ошибка запуска и ошибка операции превращаются в EngineError", async () => {
  const unauthorized = createFakeFetch([{ match: YANDEX_ASYNC, handle: () => textResponse('{"message":"unauthenticated"}', { status: 401 }) }]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: unauthorized.fetchImpl }),
    (err) => err.name === "EngineError" && err.status === 401 && /HTTP 401/.test(err.message),
  );

  const failedOperation = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-3" }) },
    { match: YANDEX_OPS, handle: () => jsonResponse({ id: "op-3", done: true, error: { code: 7, message: "permission denied" } }) },
  ]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: failedOperation.fetchImpl }),
    (err) => err.name === "EngineError" && /permission denied/.test(err.message),
  );
});

test("searchYandex: сетевые сбои опроса повторяются, 4xx при опросе — сразу ошибка", async () => {
  const xml = fixture("yandex-ok.xml");
  const { logger, lines } = collectLogger();
  const flaky = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-4" }) },
    {
      match: YANDEX_OPS,
      handle: (_u, _i, call) => {
        if (call === 1) throw new TypeError("fetch failed");
        if (call === 2) return textResponse("bad gateway", { status: 502 });
        return jsonResponse(yandexOperation(xml));
      },
    },
  ]);
  const rows = await searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: flaky.fetchImpl, logger });
  assert.equal(rows.length, 2);
  assert.equal(lines.debug.length, 2);

  const forbidden = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-5" }) },
    { match: YANDEX_OPS, handle: () => textResponse("forbidden", { status: 403 }) },
  ]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: forbidden.fetchImpl }),
    (err) => err.name === "EngineError" && err.status === 403,
  );
});

test("resolveYandexMode: известные значения, регистр, мусор → auto", () => {
  assert.equal(resolveYandexMode(undefined), "auto");
  assert.equal(resolveYandexMode("sync"), "sync");
  assert.equal(resolveYandexMode(" Async "), "async");
  assert.equal(resolveYandexMode("turbo"), "auto");
  assert.equal(resolveYandexMode(42), "auto");
});

test("searchYandex auto: HTTP 429 на запуске searchAsync → синхронный /v2/web/search с тем же телом", async () => {
  const xml = fixture("yandex-ok.xml");
  const { logger, lines } = collectLogger();
  const { fetchImpl, calls } = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => textResponse(RATE_LIMITED, { status: 429 }) },
    { match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(xml)) },
  ]);
  const rows = await searchYandex({ ...baseParams, country: "US", language: "en" }, { ...creds, ...fastYandex, fetchImpl, logger, period: "PERIOD_DAY" });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    calls.map((call) => call.url),
    [YANDEX_ASYNC, YANDEX_SYNC],
  );
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, calls[0].init.body);
  assert.equal(calls[1].init.headers.Authorization, "Api-Key test-key");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.query.searchType, "SEARCH_TYPE_COM");
  assert.equal(body.period, "PERIOD_DAY");
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /HTTP 429.*синхронным/);
});

test("searchYandex auto: 501 тоже уходит в sync; 401 и ошибки опроса — нет", async () => {
  const xml = fixture("yandex-ok.xml");
  const unknownService = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => textResponse('{"code":12,"message":"unknown service"}', { status: 501 }) },
    { match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(xml)) },
  ]);
  assert.equal((await searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: unknownService.fetchImpl })).length, 2);

  const unauthorized = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => textResponse('{"message":"unauthenticated"}', { status: 401 }) },
    { match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(xml)) },
  ]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: unauthorized.fetchImpl }),
    (err) => err.name === "EngineError" && err.status === 401,
  );
  assert.equal(unauthorized.calls.length, 1);

  // 429 при опросе операции — не повод переключаться: опрос продолжается до результата.
  const pollLimited = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-7" }) },
    { match: YANDEX_OPS, handle: (_u, _i, call) => (call === 1 ? textResponse(RATE_LIMITED, { status: 429 }) : jsonResponse(yandexOperation(xml))) },
    { match: YANDEX_SYNC, handle: () => { throw new Error("sync не должен вызываться"); } },
  ]);
  assert.equal((await searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: pollLimited.fetchImpl })).length, 2);
});

test("searchYandex: mode=async без фолбэка, mode=sync без searchAsync, ошибки sync → EngineError", async () => {
  const xml = fixture("yandex-ok.xml");
  const asyncOnly = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => textResponse(RATE_LIMITED, { status: 429 }) },
    { match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(xml)) },
  ]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: asyncOnly.fetchImpl, mode: "async" }),
    (err) => err.name === "EngineError" && err.status === 429,
  );
  assert.equal(asyncOnly.calls.length, 1);

  const syncOnly = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => { throw new Error("searchAsync не должен вызываться"); } },
    { match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(xml)) },
  ]);
  const rows = await searchYandex(baseParams, { ...creds, ...fastYandex, fetchImpl: syncOnly.fetchImpl, mode: "sync" });
  assert.equal(rows.length, 2);
  assert.deepEqual(syncOnly.calls.map((call) => call.url), [YANDEX_SYNC]);

  const syncEmpty = createFakeFetch([{ match: YANDEX_SYNC, handle: () => jsonResponse(yandexSyncResponse(fixture("yandex-error-15.xml"))) }]);
  assert.deepEqual(await searchYandex(baseParams, { ...creds, fetchImpl: syncEmpty.fetchImpl, mode: "sync" }), []);

  const syncLimited = createFakeFetch([{ match: YANDEX_SYNC, handle: () => textResponse(RATE_LIMITED, { status: 429 }) }]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, fetchImpl: syncLimited.fetchImpl, mode: "sync" }),
    (err) => err.name === "EngineError" && err.status === 429 && /синхронном/.test(err.message),
  );

  const syncNoData = createFakeFetch([{ match: YANDEX_SYNC, handle: () => jsonResponse({}) }]);
  await assert.rejects(
    searchYandex(baseParams, { ...creds, fetchImpl: syncNoData.fetchImpl, mode: "sync" }),
    (err) => err.name === "EngineError" && /rawData/.test(err.message),
  );
});

test("searchYandex: таймаут и внешняя отмена", async () => {
  const never = createFakeFetch([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-6" }) },
    { match: YANDEX_OPS, handle: () => jsonResponse({ id: "op-6", done: false }) },
  ]);
  await assert.rejects(
    searchYandex({ ...baseParams, timeoutMs: 60 }, { ...creds, pollInitialDelayMs: 5, pollIntervalMs: 5, fetchImpl: never.fetchImpl }),
    (err) => err.name === "EngineError" && /таймаут/.test(err.message),
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchYandex({ ...baseParams, signal: controller.signal }, { ...creds, ...fastYandex, fetchImpl: never.fetchImpl }),
    (err) => err.name === "AbortError",
  );
});

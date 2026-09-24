import test from "node:test";
import assert from "node:assert/strict";
import { runMultiSearch } from "../src/multi.ts";
import {
  BRAVE,
  YANDEX_ASYNC,
  YANDEX_OPS,
  collectLogger,
  createFakeFetch,
  fastYandex,
  fixture,
  happyHandlers,
  jsonResponse,
  textResponse,
} from "./helpers.mjs";

const yandexXml = fixture("yandex-ok.xml");
const braveJson = fixture("brave-ok.json");
const credentials = { yandexApiKey: "y", yandexFolderId: "f", braveApiKey: "b" };
const params = { query: "МТС новости сентябрь 2026", count: 10, timeoutMs: 5000 };

function run(handlers, overrides = {}) {
  const { fetchImpl, calls } = createFakeFetch(handlers);
  const { logger, lines } = collectLogger();
  const promise = runMultiSearch({ params, returnCount: 10, credentials, logger, fetchImpl, yandex: fastYandex, ...overrides });
  return { promise, calls, lines };
}

test("оба движка ответили: склейка, both первым, статусы и info-строка", async () => {
  const { promise, lines } = run(happyHandlers({ yandexXml, braveJson }));
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.rows.length, 3);
  assert.equal(outcome.rows[0].url, "https://moskva.mts.ru/personal/novosti/2026-09-11/mts-zapuskaet-setj-5g?utm_source=test");
  assert.equal(outcome.rows[0].published, "2026-09-11");
  assert.equal(outcome.engines.yandex.state, "ok");
  assert.equal(outcome.engines.yandex.count, 2);
  assert.equal(outcome.engines.brave.count, 2);
  assert.equal(lines.warn.length, 0);
  assert.match(lines.info[0], /yandex=2\/\d+ms brave=2\/\d+ms merged=3 returned=3/);
});

test("returnCount режет выдачу", async () => {
  const { promise } = run(happyHandlers({ yandexXml, braveJson }), { returnCount: 2 });
  assert.equal((await promise).rows.length, 2);
});

test("Яндекс упал: результаты Brave, warn в логе, complete=false", async () => {
  const { promise, lines } = run([
    { match: YANDEX_ASYNC, handle: () => textResponse("boom", { status: 500 }) },
    { match: BRAVE, handle: () => jsonResponse(JSON.parse(braveJson)) },
  ]);
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.rows.length, 2);
  assert.equal(outcome.engines.yandex.state, "failed");
  assert.match(outcome.engines.yandex.detail, /HTTP 500/);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /yandex упал .*HTTP 500.*МТС новости/);
});

test("упали оба: ok=false, provider_error, оба сообщения", async () => {
  const { promise, lines } = run([
    { match: YANDEX_ASYNC, handle: () => textResponse("boom", { status: 500 }) },
    { match: BRAVE, handle: () => textResponse("rate", { status: 403 }) },
  ]);
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "provider_error");
  assert.match(outcome.message, /Yandex: .*HTTP 500/);
  assert.match(outcome.message, /Brave: .*HTTP 403/);
  assert.equal(outcome.rows.length, 0);
  assert.equal(lines.error.length, 1);
});

test("оба вернули пусто: ok=true без ошибки", async () => {
  const { promise } = run([
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op" }) },
    { match: YANDEX_OPS, handle: () => jsonResponse({ id: "op", done: true, response: { rawData: Buffer.from(fixture("yandex-error-15.xml")).toString("base64") } }) },
    { match: BRAVE, handle: () => jsonResponse({ web: { results: [] } }) },
  ]);
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.rows, []);
});

test("нет ключей: missing_api_key без сетевых вызовов; только Brave — работает один Brave", async () => {
  const none = run(happyHandlers({ yandexXml, braveJson }), { credentials: {} });
  const outcome = await none.promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "missing_api_key");
  assert.equal(none.calls.length, 0);

  const braveOnly = run(happyHandlers({ yandexXml, braveJson }), { credentials: { braveApiKey: "b" } });
  const partial = await braveOnly.promise;
  assert.equal(partial.ok, true);
  assert.equal(partial.complete, true);
  assert.equal(partial.engines.yandex.state, "skipped");
  assert.equal(partial.rows.length, 2);
  assert.equal(braveOnly.calls.length, 1);
});

test("диапазон дат, который Яндекс не выражает периодами: отвечает один Brave", async () => {
  const { promise, calls } = run(happyHandlers({ yandexXml, braveJson }), {
    params: { ...params, dateAfter: "2026-01-01", dateBefore: "2026-03-01" },
    now: new Date("2026-09-24T02:00:00Z"),
  });
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.engines.yandex.state, "skipped");
  assert.match(outcome.engines.yandex.detail, /Brave/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(BRAVE));
  assert.match(calls[0].url, /freshness=2026-01-01to2026-03-01/);
});

test("свежесть week: Яндекс получает PERIOD_2_WEEKS, Brave — pw", async () => {
  const { promise, calls } = run(happyHandlers({ yandexXml, braveJson }), { params: { ...params, freshness: "pw" } });
  await promise;
  const yandexCall = calls.find((call) => call.url === YANDEX_ASYNC);
  assert.equal(JSON.parse(yandexCall.init.body).period, "PERIOD_2_WEEKS");
  const braveCall = calls.find((call) => call.url.startsWith(BRAVE));
  assert.match(braveCall.url, /freshness=pw/);
});

test("внешняя отмена пробрасывается как AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const { promise } = run(happyHandlers({ yandexXml, braveJson }), { params: { ...params, signal: controller.signal } });
  await assert.rejects(promise, (err) => err.name === "AbortError");
});

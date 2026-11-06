import test from "node:test";
import assert from "node:assert/strict";
import { createMultiSearchProviderPlugin, createYandexSearchProviderPlugin, parseSearchArgs, resetWarnings } from "../src/providers.ts";
import { resolveCredentials, pluginMaxResults, readEnvValue } from "../src/env.ts";
import { loadWebSearchSdk, localWebSearchSdk, resetWebSearchSdk } from "../src/sdk.ts";
import { BRAVE, YANDEX_ASYNC, collectLogger, createFakeFetch, fixture, happyHandlers, textResponse } from "./helpers.mjs";

const yandexXml = fixture("yandex-ok.xml");
const braveJson = fixture("brave-ok.json");
const env = { YC_API_KEY: "y", YC_FOLDER_ID: "f", BRAVE_SEARCH_API_KEY: "b" };
const configWithKeys = { plugins: { entries: { "openclaw-yandex-search": { config: { yandex: { apiKey: "cfg-y", folderId: "cfg-f" }, brave: { apiKey: "cfg-b" }, multi: { maxResults: 3 } } } } } };

/** Убирает из окружения процесса все ключи поиска, включая варианты *_FILE (на хосте они могут быть заданы). */
function stripSearchEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^(YC_API_KEY|YC_FOLDER_ID|BRAVE_SEARCH_API_KEY|BRAVE_API_KEY)(_FILE)?$/.test(key)) {
      delete process.env[key];
    }
  }
}

/** Оба варианта SDK: настоящий (если OpenClaw установлен, иначе loadWebSearchSdk сам откатится) и встроенный. */
const sdkVariants = [
  { name: "sdk по умолчанию", deps: {} },
  { name: "встроенный sdk", deps: { sdk: localWebSearchSdk } },
];

test("parseSearchArgs: snake_case, count по умолчанию, фильтры времени, ошибки формата", () => {
  const parsed = parseSearchArgs({ query: " МТС ", count: 3, country: "RU", language: "ru", date_after: "2026-09-01", search_lang: "ru" }, { count: 10 });
  assert.equal(parsed.query, "МТС");
  assert.equal(parsed.count, 3);
  assert.equal(parsed.country, "RU");
  assert.equal(parsed.dateAfter, "2026-09-01");
  assert.equal(parsed.searchLang, "ru");
  assert.equal(parseSearchArgs({ query: "x" }, { count: 10 }).count, 10);
  assert.equal(parseSearchArgs({ query: "x", freshness: "week" }, { count: 10 }).freshness, "pw");
  assert.equal("error" in parseSearchArgs({ query: "x", date_after: "01.09.2026" }, { count: 10 }), true);
  assert.equal("error" in parseSearchArgs({ query: "x", freshness: "week", date_after: "2026-09-01" }, { count: 10 }), true);
  assert.equal("error" in parseSearchArgs({ query: "x", date_after: "2026-09-10", date_before: "2026-09-01" }, { count: 10 }), true);
  assert.throws(() => parseSearchArgs({}, { count: 10 }));
  assert.throws(() => parseSearchArgs({ query: "x", count: 50 }, { count: 10 }));
});

test("встроенный sdk: кэш с TTL, TTL 0 отключает кэш, значения по умолчанию", () => {
  resetWebSearchSdk();
  const key = localWebSearchSdk.buildSearchCacheKey(["multi", "Запрос", 5, undefined]);
  assert.equal(key, "multi:запрос:5:default");
  assert.equal(localWebSearchSdk.readCachedSearchPayload(key, 1000), undefined);
  localWebSearchSdk.writeCachedSearchPayload(key, { results: [], count: 0 }, 60_000);
  assert.deepEqual(localWebSearchSdk.readCachedSearchPayload(key, 60_000), { results: [], count: 0, cached: true });
  localWebSearchSdk.writeCachedSearchPayload("zero", { count: 0 }, 0);
  assert.equal(localWebSearchSdk.readCachedSearchPayload("zero"), undefined);
  assert.equal(localWebSearchSdk.resolveSearchCacheTtlMs({}), 15 * 60_000);
  assert.equal(localWebSearchSdk.resolveSearchCacheTtlMs({ cacheTtlMinutes: 0 }), 0);
  assert.equal(localWebSearchSdk.resolveSearchTimeoutSeconds({}), 30);
  assert.equal(localWebSearchSdk.resolveSearchTimeoutSeconds({ timeoutSeconds: 5 }), 5);
  assert.equal(localWebSearchSdk.resolveSearchCount(undefined, 10), 10);
  assert.equal(localWebSearchSdk.resolveSearchCount(99, 10), 10);
  assert.equal(localWebSearchSdk.readConfiguredSecretString(" k ", "p"), "k");
  assert.throws(() => localWebSearchSdk.readConfiguredSecretString({ source: "env" }, "p"));
});

test("loadWebSearchSdk: возвращает объект с нужными функциями и кэшируется", async () => {
  resetWebSearchSdk();
  const sdk = await loadWebSearchSdk();
  if (process.env.REQUIRE_OPENCLAW_SDK === "1") {
    assert.notEqual(sdk, localWebSearchSdk, "CI must load the installed OpenClaw SDK without falling back");
  }
  for (const name of ["buildSearchCacheKey", "readCachedSearchPayload", "writeCachedSearchPayload", "resolveSearchCacheTtlMs", "resolveSearchTimeoutSeconds", "resolveSearchCount", "readStringParam", "readPositiveIntegerParam", "parseWebSearchTimeFilters"]) {
    assert.equal(typeof sdk[name], "function", name);
  }
  assert.equal(await loadWebSearchSdk(), sdk);
});

test("resolveCredentials: конфиг плагина приоритетнее окружения, *_FILE читается", () => {
  const fromEnv = resolveCredentials({ env });
  assert.deepEqual(fromEnv, { yandexApiKey: "y", yandexFolderId: "f", braveApiKey: "b" });
  const fromConfig = resolveCredentials({ env, config: configWithKeys });
  assert.deepEqual(fromConfig, { yandexApiKey: "cfg-y", yandexFolderId: "cfg-f", braveApiKey: "cfg-b" });
  const scoped = resolveCredentials({ env, config: configWithKeys, searchConfig: { yandex: { apiKey: "scoped-y" } } });
  assert.equal(scoped.yandexApiKey, "scoped-y");
  const { logger, lines } = collectLogger();
  const objectValue = resolveCredentials({ env, config: { plugins: { entries: { "openclaw-yandex-search": { config: { yandex: { apiKey: { source: "env" } } } } } } }, logger });
  assert.equal(objectValue.yandexApiKey, "y");
  assert.equal(lines.warn.length, 1);
  assert.equal(readEnvValue("YC_API_KEY", { YC_API_KEY_FILE: "/nonexistent/file" }), undefined);
  assert.equal(readEnvValue("YC_API_KEY", { YC_API_KEY_FILE: new URL("./fixtures/brave-ok.json", import.meta.url).pathname }).startsWith("{"), true);
  assert.equal(pluginMaxResults(configWithKeys), 3);
  assert.equal(pluginMaxResults({}, { multi: { maxResults: 50 } }), 10);
  assert.equal(pluginMaxResults({}), undefined);
});

for (const variant of sdkVariants) {
  test(`multi provider (${variant.name}): контракт ядра, кэш повторного запроса, maxResults из конфига`, async () => {
    resetWarnings();
    const { fetchImpl, calls } = createFakeFetch(happyHandlers({ yandexXml, braveJson }));
    const { logger, lines } = collectLogger();
    const provider = createMultiSearchProviderPlugin({ ...variant.deps, logger, fetchImpl });
    assert.equal(provider.id, "multi");
    assert.equal(provider.requiresCredential, false);
    assert.deepEqual(provider.envVars, ["YC_API_KEY"]);
    assert.equal(provider.credentialPath, "plugins.entries.openclaw-yandex-search.config.yandex.apiKey");

    const tool = provider.createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 15, timeoutSeconds: 5 } });
    const query = `провайдер кэш тест ${variant.name}`;
    const first = await tool.execute({ query });
    assert.deepEqual(Object.keys(first).sort(), ["count", "results", "tookMs"]);
    assert.equal(first.count, 3);
    assert.equal(first.results.length, 3);
    assert.deepEqual(Object.keys(first.results[0]).sort(), ["published", "siteName", "snippet", "title", "url"]);
    const callsAfterFirst = calls.length;

    const second = await tool.execute({ query });
    assert.equal(second.cached, true);
    assert.equal(second.results.length, 3);
    assert.equal(calls.length, callsAfterFirst);
    assert.equal(lines.warn.length, 0);
  });

  test(`multi provider (${variant.name}): count в аргументах, ошибка фильтра, provider_error, missing_api_key`, async () => {
    resetWarnings();
    const okFetch = createFakeFetch(happyHandlers({ yandexXml, braveJson })).fetchImpl;
    const tool = createMultiSearchProviderPlugin({ ...variant.deps, fetchImpl: okFetch }).createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 0 } });
    assert.equal((await tool.execute({ query: `count тест ${variant.name}`, count: 1 })).results.length, 1);
    const invalid = await tool.execute({ query: "x", date_after: "2026-13-45" });
    assert.equal(typeof invalid.error, "string");
    assert.equal("results" in invalid, false);

    const failing = createFakeFetch([
      { match: YANDEX_ASYNC, handle: () => textResponse("boom", { status: 500 }) },
      { match: BRAVE, handle: () => textResponse("boom", { status: 500 }) },
    ]).fetchImpl;
    const failed = await createMultiSearchProviderPlugin({ ...variant.deps, fetchImpl: failing })
      .createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 0 } })
      .execute({ query: `оба упали ${variant.name}` });
    assert.equal(failed.error, "provider_error");
    assert.match(failed.message, /Yandex/);
    assert.match(failed.message, /Brave/);

    const savedEnv = { ...process.env };
    stripSearchEnv();
    try {
      const { logger, lines } = collectLogger();
      const missing = await createMultiSearchProviderPlugin({ ...variant.deps, fetchImpl: okFetch, logger })
        .createTool({ searchConfig: { cacheTtlMinutes: 0 } })
        .execute({ query: `без ключей ${variant.name}` });
      assert.equal(missing.error, "missing_api_key");
      assert.equal(lines.warn.length, 2);
    } finally {
      process.env = savedEnv;
    }
  });
}

test("multi provider: отмена пробрасывается исключением", async () => {
  const tool = createMultiSearchProviderPlugin({ fetchImpl: createFakeFetch(happyHandlers({ yandexXml, braveJson })).fetchImpl }).createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 0 } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute({ query: "отмена" }, { signal: controller.signal }), (err) => err.name === "AbortError");
});

test("yandex provider: успех, provider_error, missing_yandex_api_key", async () => {
  const ok = createFakeFetch(happyHandlers({ yandexXml, braveJson })).fetchImpl;
  const provider = createYandexSearchProviderPlugin({ fetchImpl: ok });
  assert.equal(provider.id, "yandex");
  assert.equal(provider.requiresCredential, true);
  assert.deepEqual(provider.envVars, ["YC_API_KEY"]);
  assert.equal(provider.getConfiguredCredentialValue(configWithKeys), "cfg-y");
  const target = {};
  provider.setConfiguredCredentialValue(target, "new-key");
  assert.equal(target.plugins.entries["openclaw-yandex-search"].config.yandex.apiKey, "new-key");
  const scopedTarget = {};
  provider.setCredentialValue(scopedTarget, "scoped");
  assert.equal(provider.getCredentialValue(scopedTarget), "scoped");

  const tool = provider.createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 0, timeoutSeconds: 5 } });
  const result = await tool.execute({ query: "яндекс провайдер" });
  assert.equal(result.count, 2);
  assert.equal(result.results[1].siteName, "www.rbc.ru");

  const failing = createFakeFetch([{ match: YANDEX_ASYNC, handle: () => textResponse("boom", { status: 503 }) }]).fetchImpl;
  const failed = await createYandexSearchProviderPlugin({ fetchImpl: failing }).createTool({ config: configWithKeys, searchConfig: { cacheTtlMinutes: 0 } }).execute({ query: "яндекс упал" });
  assert.equal(failed.error, "provider_error");
  assert.match(failed.message, /HTTP 503/);

  const savedEnv = { ...process.env };
  stripSearchEnv();
  try {
    const missing = await createYandexSearchProviderPlugin({ fetchImpl: ok }).createTool({ searchConfig: { cacheTtlMinutes: 0 } }).execute({ query: "нет ключа" });
    assert.equal(missing.error, "missing_yandex_api_key");
  } finally {
    process.env = savedEnv;
  }
});

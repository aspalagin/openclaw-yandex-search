/**
 * Провайдеры web_search для OpenClaw: `yandex` и `multi`.
 *
 * Контракт ответа ядра (normalizeWebSearchOutput в OpenClaw 2026.9.x):
 *  - успех:  { results: [{ title, url, snippet, published?, siteName? }], count, tookMs, cached? }
 *  - ошибка: { error, message, docs? }  → ядро отдаёт модели kind: "error"
 * Всё остальное ядро отбрасывает, поэтому пометки источника здесь нет.
 */

import { PLUGIN_ID, pluginEntryConfig, pluginMaxResults, resolveCredentials } from "./env.js";
import { runMultiSearch } from "./multi.js";
import { loadWebSearchSdk, localWebSearchSdk, type WebSearchFilterError, type WebSearchSdk } from "./sdk.js";
import type { EngineSearchParams, FetchLike, PluginLogger } from "./types.js";
import { abortReason, errorMessage, silentLogger, truncate } from "./util.js";
import { resolveYandexPeriod, searchYandex } from "./yandex.js";

/** Сколько строк отдаём модели по умолчанию (ядро всё равно режет до 10). */
export const DEFAULT_RETURN_COUNT = 10;
/** Сколько просим у каждого движка: больше, чем отдаём, чтобы дедупликация и ранжирование были качественнее. */
export const ENGINE_FETCH_COUNT = 10;
const DOCS_URL = "https://docs.openclaw.ai/tools/web";
const YANDEX_DOCS_URL = "https://yandex.cloud/ru/docs/search-api/concepts/web-search";
const YANDEX_SIGNUP_URL = "https://yandex.cloud/ru/docs/search-api/";
const YANDEX_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.yandex.apiKey`;
const BRAVE_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.brave.apiKey`;

export interface ProviderDeps {
  logger?: PluginLogger;
  /** plugins.entries.<id>.config из register(api); живой конфиг из ctx.config имеет приоритет. */
  pluginConfig?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  /** Источник текущего времени (для тестов). */
  now?: () => Date;
  /** SDK-хелперы; по умолчанию настоящий SDK OpenClaw с откатом на встроенную реализацию. */
  sdk?: WebSearchSdk;
}

export interface ProviderToolContext {
  config?: unknown;
  searchConfig?: Record<string, unknown>;
  agentDir?: string;
  runtimeMetadata?: unknown;
}

export interface ProviderToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
}

/** Зеркало контракта WebSearchProviderPlugin ядра (dist/api-*.d.ts, OpenClaw 2026.9.5). */
export interface WebSearchProviderShape {
  id: string;
  label: string;
  hint: string;
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: unknown) => unknown;
  setConfiguredCredentialValue?: (configTarget: Record<string, unknown>, value: unknown) => void;
  createTool: (ctx: ProviderToolContext) => ProviderToolDefinition | null;
}

export const WEB_SEARCH_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string (поисковый запрос)." },
    count: { type: "integer", description: "Number of results to return (1-10).", minimum: 1, maximum: 10 },
    country: {
      type: "string",
      description: "2-letter country code (RU, US, DE, ALL). Yandex: RU/TR/KZ/BY/UZ choose the search domain, other codes use yandex.com.",
    },
    language: { type: "string", description: "ISO 639-1 language code (ru, en, ...)." },
    freshness: { type: "string", description: "Time filter: day, week, month or year." },
    date_after: { type: "string", description: "Only results published after this date (YYYY-MM-DD)." },
    date_before: { type: "string", description: "Only results published before this date (YYYY-MM-DD)." },
    search_lang: { type: "string", description: "Brave result language code (en, en-gb, ru, ...)." },
    ui_lang: { type: "string", description: "Brave UI locale in language-region form (en-US)." },
  },
  required: ["query"],
};

export interface ParsedSearchArgs {
  query: string;
  count: number;
  country?: string;
  language?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}

/** Разбирает аргументы инструмента (snake_case, как их передаёт ядро) и фильтры времени. */
export function parseSearchArgs(
  args: Record<string, unknown>,
  defaults: { count: number },
  sdk: WebSearchSdk = localWebSearchSdk,
): ParsedSearchArgs | WebSearchFilterError {
  const query = sdk.readStringParam(args, "query", { required: true }) ?? "";
  const rawCount = sdk.readPositiveIntegerParam(args, "count", { max: 10, message: "count must be an integer from 1 to 10." });
  const count = sdk.resolveSearchCount(rawCount, defaults.count);
  const time = sdk.parseWebSearchTimeFilters({
    rawDateAfter: sdk.readStringParam(args, "date_after"),
    rawDateBefore: sdk.readStringParam(args, "date_before"),
    rawFreshness: sdk.readStringParam(args, "freshness"),
    freshnessProvider: "brave",
    docs: DOCS_URL,
    invalidFreshnessMessage: "freshness must be day, week, month, or year.",
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in time) {
    return time;
  }
  return {
    query,
    count,
    country: sdk.readStringParam(args, "country"),
    language: sdk.readStringParam(args, "language"),
    searchLang: sdk.readStringParam(args, "search_lang"),
    uiLang: sdk.readStringParam(args, "ui_lang"),
    freshness: time.freshness,
    dateAfter: time.dateAfter,
    dateBefore: time.dateBefore,
  };
}

function resolveReturnCount(sdk: WebSearchSdk, ctx: ProviderToolContext, pluginConfig?: Record<string, unknown>): number {
  const fromSearch = ctx.searchConfig?.maxResults;
  if (typeof fromSearch === "number" && Number.isFinite(fromSearch)) {
    return sdk.resolveSearchCount(fromSearch, DEFAULT_RETURN_COUNT);
  }
  return pluginMaxResults(ctx.config, pluginConfig) ?? DEFAULT_RETURN_COUNT;
}

function toEngineParams(parsed: ParsedSearchArgs, extra: { signal?: AbortSignal; timeoutMs: number }): EngineSearchParams {
  return {
    query: parsed.query,
    count: ENGINE_FETCH_COUNT,
    country: parsed.country,
    language: parsed.language,
    searchLang: parsed.searchLang,
    uiLang: parsed.uiLang,
    freshness: parsed.freshness,
    dateAfter: parsed.dateAfter,
    dateBefore: parsed.dateBefore,
    signal: extra.signal,
    timeoutMs: extra.timeoutMs,
  };
}

function cacheKeyFor(sdk: WebSearchSdk, prefix: string, parsed: ParsedSearchArgs): string {
  return sdk.buildSearchCacheKey([
    prefix,
    parsed.query,
    parsed.count,
    parsed.country,
    parsed.language,
    parsed.searchLang,
    parsed.uiLang,
    parsed.freshness,
    parsed.dateAfter,
    parsed.dateBefore,
  ]);
}

const warnedOnce = new Set<string>();

function warnOnce(logger: PluginLogger, key: string, message: string): void {
  if (warnedOnce.has(key)) {
    return;
  }
  warnedOnce.add(key);
  logger.warn(message);
}

/** Для тестов: сбросить одноразовые предупреждения. */
export function resetWarnings(): void {
  warnedOnce.clear();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Ключ Яндекса как «основной» credential обоих провайдеров: tools.web.search.yandex.apiKey ↔ plugins.entries.<id>.config.yandex.apiKey. */
function credentialAccessors(): Pick<
  WebSearchProviderShape,
  "credentialPath" | "getCredentialValue" | "setCredentialValue" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
> {
  return {
    credentialPath: YANDEX_CREDENTIAL_PATH,
    getCredentialValue: (searchConfig) => asRecord(searchConfig?.yandex)?.apiKey,
    setCredentialValue: (target, value) => {
      const yandex = (asRecord(target.yandex) ?? (target.yandex = {})) as Record<string, unknown>;
      yandex.apiKey = value;
    },
    getConfiguredCredentialValue: (config) => asRecord(pluginEntryConfig(config)?.yandex)?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (asRecord(configTarget.plugins) ?? (configTarget.plugins = {})) as Record<string, unknown>;
      const entries = (asRecord(plugins.entries) ?? (plugins.entries = {})) as Record<string, unknown>;
      const entry = (asRecord(entries[PLUGIN_ID]) ?? (entries[PLUGIN_ID] = {})) as Record<string, unknown>;
      const config = (asRecord(entry.config) ?? (entry.config = {})) as Record<string, unknown>;
      const yandex = (asRecord(config.yandex) ?? (config.yandex = {})) as Record<string, unknown>;
      yandex.apiKey = value;
    },
  };
}

// =============================================================================
// multi
// =============================================================================

export function createMultiSearchProviderPlugin(deps: ProviderDeps = {}): WebSearchProviderShape {
  const logger = deps.logger ?? silentLogger;
  return {
    id: "multi",
    label: "Multi-Search (Yandex + Brave)",
    hint: "Параллельный поиск Yandex Search API + Brave Search с дедупликацией; работает, если настроен хотя бы один движок.",
    requiresCredential: false,
    credentialLabel: "Yandex Cloud API Key",
    // Только имя ключа Яндекса: ядро подставляет первую найденную переменную из этого списка
    // в credential провайдера (yandex.apiKey), поэтому *_FILE и ключи Brave здесь недопустимы.
    envVars: ["YC_API_KEY"],
    placeholder: "AQVN...",
    signupUrl: YANDEX_SIGNUP_URL,
    docsUrl: YANDEX_DOCS_URL,
    autoDetectOrder: 20,
    inactiveSecretPaths: [],
    ...credentialAccessors(),
    createTool: (ctx) => ({
      description:
        "Параллельный веб-поиск через Yandex Search API и Brave Search; результаты объединены и дедуплицированы. " +
        "Поддерживает count, country, language, freshness, date_after/date_before.",
      parameters: WEB_SEARCH_PARAMETERS,
      execute: async (args, context) => {
        const sdk = deps.sdk ?? (await loadWebSearchSdk(logger));
        const parsed = parseSearchArgs(args, { count: resolveReturnCount(sdk, ctx, deps.pluginConfig) }, sdk);
        if ("error" in parsed) {
          return parsed;
        }
        const timeoutMs = sdk.resolveSearchTimeoutSeconds(ctx.searchConfig) * 1000;
        const cacheTtlMs = sdk.resolveSearchCacheTtlMs(ctx.searchConfig);
        const cacheKey = cacheKeyFor(sdk, "multi", parsed);
        if (cacheTtlMs > 0) {
          const cached = sdk.readCachedSearchPayload(cacheKey, cacheTtlMs);
          if (cached) {
            return cached;
          }
        }

        const credentials = resolveCredentials({
          config: ctx.config,
          searchConfig: ctx.searchConfig,
          pluginConfig: deps.pluginConfig,
          logger,
          sdk,
        });
        if (!credentials.yandexApiKey || !credentials.yandexFolderId) {
          warnOnce(logger, "multi:yandex", `[multi-search] Яндекс отключён: нет YC_API_KEY/YC_FOLDER_ID (или ${YANDEX_CREDENTIAL_PATH})`);
        }
        if (!credentials.braveApiKey) {
          warnOnce(logger, "multi:brave", `[multi-search] Brave отключён: нет BRAVE_SEARCH_API_KEY (или ${BRAVE_CREDENTIAL_PATH})`);
        }

        const outcome = await runMultiSearch({
          params: toEngineParams(parsed, { signal: context?.signal, timeoutMs }),
          returnCount: parsed.count,
          credentials,
          logger,
          fetchImpl: deps.fetchImpl,
          now: deps.now?.(),
        });
        if (!outcome.ok) {
          return {
            error: outcome.error ?? "provider_error",
            message: outcome.message ?? "web_search (multi): поиск не удался",
            docs: DOCS_URL,
          };
        }
        const payload = { results: outcome.rows, count: outcome.rows.length, tookMs: outcome.tookMs };
        if (outcome.complete && cacheTtlMs > 0) {
          sdk.writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
        }
        return payload;
      },
    }),
  };
}

// =============================================================================
// yandex
// =============================================================================

export function createYandexSearchProviderPlugin(deps: ProviderDeps = {}): WebSearchProviderShape {
  const logger = deps.logger ?? silentLogger;
  return {
    id: "yandex",
    label: "Yandex Search",
    hint: "Поиск через Yandex Search API v2 (отложенный режим): российские и мировые результаты.",
    requiresCredential: true,
    credentialLabel: "Yandex Cloud API Key",
    // См. комментарий у multi: YC_API_KEY_FILE плагин читает сам, ядру его показывать нельзя.
    envVars: ["YC_API_KEY"],
    placeholder: "AQVN...",
    signupUrl: YANDEX_SIGNUP_URL,
    docsUrl: YANDEX_DOCS_URL,
    autoDetectOrder: 5,
    inactiveSecretPaths: [],
    ...credentialAccessors(),
    createTool: (ctx) => ({
      description: "Веб-поиск через Yandex Search API v2. Возвращает заголовки, URL, сниппеты и даты документов.",
      parameters: WEB_SEARCH_PARAMETERS,
      execute: async (args, context) => {
        const sdk = deps.sdk ?? (await loadWebSearchSdk(logger));
        const parsed = parseSearchArgs(args, { count: resolveReturnCount(sdk, ctx, deps.pluginConfig) }, sdk);
        if ("error" in parsed) {
          return parsed;
        }
        const credentials = resolveCredentials({
          config: ctx.config,
          searchConfig: ctx.searchConfig,
          pluginConfig: deps.pluginConfig,
          logger,
          sdk,
        });
        if (!credentials.yandexApiKey || !credentials.yandexFolderId) {
          return {
            error: "missing_yandex_api_key",
            message:
              "web_search (yandex): нужны YC_API_KEY (или YC_API_KEY_FILE) и YC_FOLDER_ID в окружении Gateway " +
              `либо ${YANDEX_CREDENTIAL_PATH} и plugins.entries.${PLUGIN_ID}.config.yandex.folderId.`,
            docs: DOCS_URL,
          };
        }

        const timeoutMs = sdk.resolveSearchTimeoutSeconds(ctx.searchConfig) * 1000;
        const cacheTtlMs = sdk.resolveSearchCacheTtlMs(ctx.searchConfig);
        const cacheKey = cacheKeyFor(sdk, "yandex", parsed);
        if (cacheTtlMs > 0) {
          const cached = sdk.readCachedSearchPayload(cacheKey, cacheTtlMs);
          if (cached) {
            return cached;
          }
        }

        const period = resolveYandexPeriod({
          freshness: parsed.freshness,
          dateAfter: parsed.dateAfter,
          dateBefore: parsed.dateBefore,
          now: deps.now?.(),
        });
        if (period.coverage === "none") {
          logger.warn(`[yandex-search] фильтр по дате не применён: ${period.note}`);
        } else if (period.note) {
          logger.debug?.(`[yandex-search] period=${period.period} (${period.note})`);
        }

        const startedAt = Date.now();
        try {
          const rows = (
            await searchYandex(toEngineParams(parsed, { signal: context?.signal, timeoutMs }), {
              apiKey: credentials.yandexApiKey,
              folderId: credentials.yandexFolderId,
              fetchImpl: deps.fetchImpl,
              logger,
              period: period.period,
            })
          ).slice(0, parsed.count);
          const payload = { results: rows, count: rows.length, tookMs: Date.now() - startedAt };
          logger.info(`[yandex-search] results=${rows.length} tookMs=${payload.tookMs}`);
          if (cacheTtlMs > 0) {
            sdk.writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
          }
          return payload;
        } catch (err) {
          if (context?.signal?.aborted) {
            throw abortReason(context.signal);
          }
          const message = errorMessage(err);
          logger.warn(`[yandex-search] упал за ${Date.now() - startedAt} мс: ${message} | запрос: «${truncate(parsed.query, 80)}»`);
          return { error: "provider_error", message: `web_search (yandex): ${message}`, docs: DOCS_URL };
        }
      },
    }),
  };
}

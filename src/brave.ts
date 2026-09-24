/**
 * Brave Search API (web search): GET https://api.search.brave.com/res/v1/web/search
 */

import type { EngineSearchParams, FetchLike, PluginLogger, SearchRow } from "./types.js";
import {
  EngineError,
  hostnameOf,
  isHttpUrl,
  readResponseText,
  silentLogger,
  sleep,
  stripMarkup,
  toEngineError,
  toIsoDate,
  withTimeout,
} from "./util.js";

export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_MAX_COUNT = 20;
/** Brave на дешёвых планах пропускает один запрос в секунду; одна повторная попытка после 429. */
const BRAVE_RETRY_DELAY_MS = 1100;

const BRAVE_COUNTRIES = new Set([
  "AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI", "FR", "DE", "GR", "HK", "IN", "ID", "IT", "JP", "KR",
  "MY", "MX", "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA", "ES", "SE", "CH", "TW", "TR", "GB",
  "US", "ALL",
]);

const BRAVE_SEARCH_LANGS = new Set([
  "ar", "eu", "bn", "bg", "ca", "zh-hans", "zh-hant", "hr", "cs", "da", "nl", "en", "en-gb", "et", "fi", "fr",
  "gl", "de", "el", "gu", "he", "hi", "hu", "is", "it", "jp", "kn", "ko", "lv", "lt", "ms", "ml", "mr", "nb",
  "pl", "pt-br", "pt-pt", "pa", "ro", "ru", "sr", "sk", "sl", "es", "sv", "ta", "te", "th", "tr", "uk", "vi",
]);

const BRAVE_SEARCH_LANG_ALIASES: Record<string, string> = {
  ja: "jp",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-hk": "zh-hant",
  "zh-sg": "zh-hans",
  "zh-tw": "zh-hant",
};

/** Известная страна → её код, неизвестная → ALL (как в официальном Brave-плагине OpenClaw). */
export function normalizeBraveCountry(value?: string): string | undefined {
  const code = value?.trim().toUpperCase();
  if (!code) {
    return undefined;
  }
  return BRAVE_COUNTRIES.has(code) ? code : "ALL";
}

export function normalizeBraveSearchLang(value?: string): string | undefined {
  const lower = value?.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  const canonical = BRAVE_SEARCH_LANG_ALIASES[lower] ?? lower;
  return BRAVE_SEARCH_LANGS.has(canonical) ? canonical : undefined;
}

export function normalizeBraveUiLang(value?: string): string | undefined {
  const match = value?.trim().match(/^([a-z]{2})[-_]([a-z]{2})$/i);
  return match ? `${match[1].toLowerCase()}-${match[2].toUpperCase()}` : undefined;
}

/** URL запроса к Brave со всеми поддерживаемыми фильтрами. */
export function buildBraveSearchUrl(params: EngineSearchParams, today: string = new Date().toISOString().slice(0, 10)): URL {
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(Math.min(BRAVE_MAX_COUNT, Math.max(1, Math.floor(params.count)))));
  // Без <strong>-подсветки в title/description: нечего вычищать.
  url.searchParams.set("text_decorations", "false");

  const country = normalizeBraveCountry(params.country);
  if (country) {
    url.searchParams.set("country", country);
  }
  const searchLang = normalizeBraveSearchLang(params.searchLang ?? params.language);
  if (searchLang) {
    url.searchParams.set("search_lang", searchLang);
  }
  const uiLang = normalizeBraveUiLang(params.uiLang);
  if (uiLang) {
    url.searchParams.set("ui_lang", uiLang);
  }

  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set("freshness", `${params.dateAfter}to${today}`);
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }
  return url;
}

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
  page_age?: unknown;
  meta_url?: { hostname?: unknown };
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/** Строки формата ядра из ответа Brave; записи без валидного http-URL отбрасываются. */
export function mapBraveResults(data: BraveResponse): SearchRow[] {
  const rows: SearchRow[] = [];
  const results = Array.isArray(data.web?.results) ? data.web.results : [];
  for (const entry of results) {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!isHttpUrl(url)) {
      continue;
    }
    const row: SearchRow = {
      title: stripMarkup(entry.title) || hostnameOf(url) || url,
      url,
      snippet: stripMarkup(entry.description),
    };
    const published = toIsoDate(entry.page_age) ?? toIsoDate(entry.age);
    if (published) {
      row.published = published;
    }
    const hostname = typeof entry.meta_url?.hostname === "string" ? entry.meta_url.hostname : hostnameOf(url);
    if (hostname) {
      row.siteName = hostname;
    }
    rows.push(row);
  }
  return rows;
}

export interface BraveEngineOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  logger?: PluginLogger;
  retryDelayMs?: number;
  /** Сегодняшняя дата YYYY-MM-DD (для тестов). */
  today?: string;
}

/** Один запрос к Brave с одной повторной попыткой после HTTP 429. Бросает EngineError при сбое. */
export async function searchBrave(params: EngineSearchParams, options: BraveEngineOptions): Promise<SearchRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? silentLogger;
  const signal = withTimeout(params.timeoutMs, params.signal);
  const failure = (err: unknown) => toEngineError("brave", err, { externalSignal: params.signal, timeoutMs: params.timeoutMs });
  const url = buildBraveSearchUrl(params, options.today).toString();
  const headers = { Accept: "application/json", "X-Subscription-Token": options.apiKey };
  let retried = false;

  for (;;) {
    try {
      const response = await fetchImpl(url, { headers, signal });
      if (response.status === 429 && !retried) {
        retried = true;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 5
            ? retryAfter * 1000
            : (options.retryDelayMs ?? BRAVE_RETRY_DELAY_MS);
        await readResponseText(response);
        logger.debug?.(`[brave] HTTP 429, повтор через ${delay} мс`);
        await sleep(delay, signal);
        continue;
      }
      if (!response.ok) {
        throw new EngineError("brave", `HTTP ${response.status}: ${await readResponseText(response)}`, {
          status: response.status,
        });
      }
      return mapBraveResults((await response.json()) as BraveResponse);
    } catch (err) {
      throw failure(err);
    }
  }
}

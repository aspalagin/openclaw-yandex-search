/**
 * Yandex Search API v2, отложенный режим.
 *
 * POST https://searchapi.api.cloud.yandex.net/v2/web/searchAsync  → id операции,
 * затем GET https://operation.api.cloud.yandex.net/operations/{id} до done=true.
 * Результат — base64-XML (<yandexsearch>) в response.rawData.
 *
 * Синхронный режим (/v2/web/search) намеренно не используется: по тарифу Yandex Search API
 * синхронный запрос примерно в 16 раз дороже отложенного (пример расчёта в документации:
 * 250 000 синхронных = 122 000 ₽, 50 000 отложенных = 1 525 ₽).
 */

import { XMLParser } from "fast-xml-parser";
import type { EngineSearchParams, FetchLike, PluginLogger, SearchRow } from "./types.js";
import {
  EngineError,
  errorMessage,
  hostnameOf,
  isHttpUrl,
  readResponseText,
  silentLogger,
  sleep,
  stripMarkup,
  toEngineError,
  toIsoDate,
  truncate,
  withTimeout,
} from "./util.js";

export const YANDEX_SEARCH_ASYNC_URL = "https://searchapi.api.cloud.yandex.net/v2/web/searchAsync";
export const YANDEX_OPERATIONS_URL = "https://operation.api.cloud.yandex.net/operations/";
/** Первый опрос операции: по замерам Яндекс обычно готов уже через доли секунды. */
export const YANDEX_POLL_INITIAL_DELAY_MS = 300;
export const YANDEX_POLL_INTERVAL_MS = 500;
/** Ограничение API на длину queryText. */
export const YANDEX_MAX_QUERY_LENGTH = 400;
/** Код «Искомая комбинация слов нигде не встречается»: это пустая выдача, а не сбой. */
export const YANDEX_NO_RESULTS_ERROR_CODE = "15";
const MOSCOW_REGION_ID = "213";

export type YandexSearchType =
  | "SEARCH_TYPE_RU"
  | "SEARCH_TYPE_TR"
  | "SEARCH_TYPE_COM"
  | "SEARCH_TYPE_KK"
  | "SEARCH_TYPE_BE"
  | "SEARCH_TYPE_UZ";

export type YandexLocalization =
  | "LOCALIZATION_RU"
  | "LOCALIZATION_UK"
  | "LOCALIZATION_BE"
  | "LOCALIZATION_KK"
  | "LOCALIZATION_TR"
  | "LOCALIZATION_EN";

/** Периоды, которые поддерживает поле `period` Search API v2. */
export type YandexPeriod = "PERIOD_DAY" | "PERIOD_2_WEEKS" | "PERIOD_MONTH";

const COUNTRY_TO_SEARCH_TYPE: Record<string, YandexSearchType> = {
  RU: "SEARCH_TYPE_RU",
  TR: "SEARCH_TYPE_TR",
  KZ: "SEARCH_TYPE_KK",
  BY: "SEARCH_TYPE_BE",
  UZ: "SEARCH_TYPE_UZ",
};

const LANGUAGE_TO_LOCALIZATION: Record<string, YandexLocalization> = {
  ru: "LOCALIZATION_RU",
  uk: "LOCALIZATION_UK",
  be: "LOCALIZATION_BE",
  kk: "LOCALIZATION_KK",
  tr: "LOCALIZATION_TR",
  en: "LOCALIZATION_EN",
};

const SEARCH_TYPE_DEFAULT_LOCALIZATION: Record<YandexSearchType, YandexLocalization> = {
  SEARCH_TYPE_RU: "LOCALIZATION_RU",
  SEARCH_TYPE_TR: "LOCALIZATION_TR",
  SEARCH_TYPE_COM: "LOCALIZATION_EN",
  SEARCH_TYPE_KK: "LOCALIZATION_KK",
  SEARCH_TYPE_BE: "LOCALIZATION_BE",
  SEARCH_TYPE_UZ: "LOCALIZATION_RU",
};

/** Страна → домен поиска. RU/TR/KZ/BY/UZ имеют свои домены, остальные (и ALL) идут на yandex.com. */
export function resolveYandexSearchType(country?: string): YandexSearchType {
  const code = country?.trim().toUpperCase();
  if (!code) {
    return "SEARCH_TYPE_RU";
  }
  return COUNTRY_TO_SEARCH_TYPE[code] ?? "SEARCH_TYPE_COM";
}

export function resolveYandexLocalization(language: string | undefined, searchType: YandexSearchType): YandexLocalization {
  const code = language?.trim().toLowerCase().split(/[-_]/)[0];
  return (code && LANGUAGE_TO_LOCALIZATION[code]) || SEARCH_TYPE_DEFAULT_LOCALIZATION[searchType];
}

export interface YandexPeriodDecision {
  period?: YandexPeriod;
  /** exact — фильтр совпадает с запросом; superset — шире запроса; none — выразить нельзя. */
  coverage: "exact" | "superset" | "none";
  note?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Яндекс фильтрует по дате только грубыми периодами (сутки, 2 недели, месяц).
 * Подбирает ближайший период, накрывающий запрошенный диапазон.
 */
export function resolveYandexPeriod(filters: {
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  now?: Date;
}): YandexPeriodDecision {
  const now = filters.now ?? new Date();
  if (filters.freshness) {
    switch (filters.freshness) {
      case "pd":
        return { period: "PERIOD_DAY", coverage: "exact" };
      case "pw":
        return { period: "PERIOD_2_WEEKS", coverage: "superset", note: "неделя расширена до 2 недель" };
      case "pm":
        return { period: "PERIOD_MONTH", coverage: "exact" };
      default:
        return { coverage: "none", note: `свежесть «${filters.freshness}» шире месяца` };
    }
  }
  if (!filters.dateAfter && !filters.dateBefore) {
    return { coverage: "exact" };
  }
  const today = now.toISOString().slice(0, 10);
  if (filters.dateBefore && filters.dateBefore < today) {
    return { coverage: "none", note: "верхняя граница даты в прошлом" };
  }
  if (!filters.dateAfter) {
    return { coverage: "exact" };
  }
  const after = Date.parse(`${filters.dateAfter}T00:00:00Z`);
  if (!Number.isFinite(after)) {
    return { coverage: "none", note: "нижняя граница даты не распознана" };
  }
  const days = (now.getTime() - after) / DAY_MS;
  if (days <= 1) {
    return { period: "PERIOD_DAY", coverage: "superset" };
  }
  if (days <= 14) {
    return { period: "PERIOD_2_WEEKS", coverage: "superset" };
  }
  if (days <= 31) {
    return { period: "PERIOD_MONTH", coverage: "superset" };
  }
  return { coverage: "none", note: "нижняя граница даты старше месяца" };
}

export interface YandexRequestOptions {
  query: string;
  count: number;
  folderId: string;
  searchType: YandexSearchType;
  localization: YandexLocalization;
  period?: YandexPeriod;
}

/** Тело запроса WebSearch.SearchAsync (поля по справочнику API v2). */
export function buildYandexRequestBody(options: YandexRequestOptions): Record<string, unknown> {
  const queryText = options.query.trim().slice(0, YANDEX_MAX_QUERY_LENGTH);
  const body: Record<string, unknown> = {
    query: {
      searchType: options.searchType,
      queryText,
      familyMode: "FAMILY_MODE_NONE",
      page: 0,
    },
    sortSpec: {
      sortMode: "SORT_MODE_BY_RELEVANCE",
      sortOrder: "SORT_ORDER_DESC",
    },
    groupSpec: {
      groupMode: "GROUP_MODE_DEEP",
      groupsOnPage: Math.min(100, Math.max(1, Math.floor(options.count))),
      docsInGroup: 1,
    },
    maxPassages: 2,
    l10n: options.localization,
    folderId: options.folderId,
    responseFormat: "FORMAT_XML",
  };
  if (options.searchType === "SEARCH_TYPE_RU") {
    body.region = MOSCOW_REGION_ID;
  }
  if (options.period) {
    body.period = options.period;
  }
  return body;
}

// =============================================================================
// Разбор XML
// =============================================================================

interface ParsedTextNode {
  "#text"?: unknown;
}

interface ParsedDoc {
  "@_url"?: unknown;
  url?: unknown;
  domain?: unknown;
  title?: unknown;
  headline?: unknown;
  passages?: { passage?: unknown };
  modtime?: unknown;
}

interface ParsedGroup {
  doc?: ParsedDoc | ParsedDoc[];
}

interface ParsedGrouping {
  group?: ParsedGroup | ParsedGroup[];
}

interface ParsedResponse {
  error?: unknown;
  results?: { grouping?: ParsedGrouping | ParsedGrouping[] };
  grouping?: ParsedGrouping;
}

interface ParsedXml {
  yandexsearch?: { response?: ParsedResponse };
}

export interface YandexParseResult {
  rows: SearchRow[];
  error?: { code?: string; message: string };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Текст узла: stopNodes отдают сырую строку с <hlword>, иначе объект с #text. */
function textOf(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "string" || typeof raw === "number") {
    return stripMarkup(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(textOf).filter(Boolean).join(" ").trim();
  }
  if (typeof raw === "object") {
    return stripMarkup((raw as ParsedTextNode)["#text"]);
  }
  return "";
}

function passagesOf(raw: ParsedDoc["passages"]): string {
  const passage = raw?.passage;
  if (Array.isArray(passage)) {
    return passage.map(textOf).filter(Boolean).join(" … ");
  }
  return textOf(passage);
}

function errorOf(response: ParsedResponse): YandexParseResult["error"] {
  const raw = response.error;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string" || typeof raw === "number") {
    return { message: stripMarkup(raw) || "неизвестная ошибка" };
  }
  if (typeof raw === "object") {
    const node = raw as Record<string, unknown>;
    const code = node["@_code"];
    return {
      code: code === undefined || code === null ? undefined : String(code),
      message: stripMarkup(node["#text"]) || "неизвестная ошибка",
    };
  }
  return { message: String(raw) };
}

function docToRow(doc: ParsedDoc): SearchRow | undefined {
  const rawUrl = typeof doc["@_url"] === "string" ? doc["@_url"] : typeof doc.url === "string" ? doc.url : "";
  const url = rawUrl.trim();
  if (!isHttpUrl(url)) {
    return undefined;
  }
  const title = textOf(doc.title) || hostnameOf(url) || url;
  const snippet = passagesOf(doc.passages) || textOf(doc.headline);
  const row: SearchRow = { title, url, snippet };
  const published = toIsoDate(doc.modtime);
  if (published) {
    row.published = published;
  }
  const domain = typeof doc.domain === "string" ? doc.domain.trim() : "";
  const siteName = domain || hostnameOf(url);
  if (siteName) {
    row.siteName = siteName;
  }
  return row;
}

/** Разбирает XML-ответ Search API v2 в строки формата ядра. */
export function parseYandexXml(xml: string): YandexParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
    stopNodes: ["*.title", "*.passage"],
  });

  let parsed: ParsedXml;
  try {
    parsed = parser.parse(xml) as ParsedXml;
  } catch (err) {
    return { rows: [], error: { message: `XML не разобран: ${errorMessage(err)}` } };
  }

  const response = parsed?.yandexsearch?.response;
  if (!response) {
    return { rows: [], error: { message: "в ответе нет yandexsearch.response" } };
  }
  const error = errorOf(response);
  if (error) {
    return { rows: [], error };
  }

  const rawGrouping = response.results?.grouping ?? response.grouping;
  const grouping = Array.isArray(rawGrouping) ? rawGrouping[0] : rawGrouping;
  const rows: SearchRow[] = [];
  for (const group of toArray(grouping?.group)) {
    for (const doc of toArray(group.doc)) {
      const row = docToRow(doc);
      if (row) {
        rows.push(row);
      }
    }
  }
  return { rows };
}

// =============================================================================
// Вызов API
// =============================================================================

export interface YandexEngineOptions {
  apiKey: string;
  folderId: string;
  fetchImpl?: FetchLike;
  logger?: PluginLogger;
  pollInitialDelayMs?: number;
  pollIntervalMs?: number;
  period?: YandexPeriod;
}

interface OperationPayload {
  id?: unknown;
  done?: unknown;
  error?: unknown;
  response?: { rawData?: unknown };
}

function describeOperationError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const node = error as Record<string, unknown>;
    const message = typeof node.message === "string" ? node.message : JSON.stringify(error);
    return node.code === undefined ? message : `${message} (код ${String(node.code)})`;
  }
  return String(error);
}

/**
 * Выполняет поиск в отложенном режиме. Бросает EngineError при любом сбое;
 * внешняя отмена пробрасывается как AbortError.
 */
export async function searchYandex(params: EngineSearchParams, options: YandexEngineOptions): Promise<SearchRow[]> {
  const timeout = withTimeout(params.timeoutMs, params.signal);
  try {
    return await runYandexSearch(params, options, timeout.signal);
  } finally {
    timeout.clear();
  }
}

async function runYandexSearch(params: EngineSearchParams, options: YandexEngineOptions, signal: AbortSignal): Promise<SearchRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? silentLogger;
  const failure = (err: unknown) => toEngineError("yandex", err, { externalSignal: params.signal, timeoutMs: params.timeoutMs });
  const searchType = resolveYandexSearchType(params.country);
  const body = buildYandexRequestBody({
    query: params.query,
    count: params.count,
    folderId: options.folderId,
    searchType,
    localization: resolveYandexLocalization(params.language, searchType),
    period: options.period,
  });
  const authHeader = { Authorization: `Api-Key ${options.apiKey}` };

  let operationId: string;
  try {
    const response = await fetchImpl(YANDEX_SEARCH_ASYNC_URL, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new EngineError("yandex", `HTTP ${response.status} при запуске поиска: ${await readResponseText(response)}`, {
        status: response.status,
      });
    }
    const payload = (await response.json()) as OperationPayload;
    if (typeof payload.id !== "string" || !payload.id) {
      throw new EngineError("yandex", `ответ без id операции: ${truncate(JSON.stringify(payload), 300)}`);
    }
    operationId = payload.id;
  } catch (err) {
    throw failure(err);
  }

  const deadline = Date.now() + params.timeoutMs;
  const pollUrl = `${YANDEX_OPERATIONS_URL}${encodeURIComponent(operationId)}`;
  let delay = options.pollInitialDelayMs ?? YANDEX_POLL_INITIAL_DELAY_MS;
  const interval = options.pollIntervalMs ?? YANDEX_POLL_INTERVAL_MS;

  for (;;) {
    try {
      await sleep(delay, signal);
    } catch (err) {
      throw failure(err);
    }
    delay = interval;
    if (Date.now() >= deadline) {
      throw new EngineError("yandex", `таймаут ${params.timeoutMs} мс: операция ${operationId} не завершилась`);
    }

    let payload: OperationPayload;
    try {
      const response = await fetchImpl(pollUrl, { headers: authHeader, signal });
      if (!response.ok) {
        const detail = await readResponseText(response);
        if (response.status === 429 || response.status >= 500) {
          logger.debug?.(`[yandex] опрос операции ${operationId}: HTTP ${response.status}, повтор`);
          continue;
        }
        throw new EngineError("yandex", `HTTP ${response.status} при опросе операции: ${detail}`, { status: response.status });
      }
      payload = (await response.json()) as OperationPayload;
    } catch (err) {
      if (err instanceof EngineError || signal.aborted) {
        throw failure(err);
      }
      logger.debug?.(`[yandex] опрос операции ${operationId}: ${errorMessage(err)}, повтор`);
      continue;
    }

    if (payload.error !== undefined && payload.error !== null) {
      throw new EngineError("yandex", `операция завершилась ошибкой: ${describeOperationError(payload.error)}`);
    }
    if (!payload.done) {
      continue;
    }
    const rawData = payload.response?.rawData;
    if (typeof rawData !== "string" || !rawData) {
      throw new EngineError("yandex", "операция завершена, но rawData пуст");
    }
    const parsed = parseYandexXml(Buffer.from(rawData, "base64").toString("utf8"));
    if (parsed.error) {
      if (parsed.error.code === YANDEX_NO_RESULTS_ERROR_CODE) {
        return [];
      }
      const code = parsed.error.code ? ` (код ${parsed.error.code})` : "";
      throw new EngineError("yandex", `ошибка поиска${code}: ${parsed.error.message}`);
    }
    return parsed.rows;
  }
}

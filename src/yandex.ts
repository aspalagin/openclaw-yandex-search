/**
 * Yandex Search API v2 Provider
 *
 * Реализует контракт WebSearchProviderPlugin.
 * API endpoint: https://searchapi.api.cloud.yandex.net/v2/web/searchAsync
 * Авторизация: заголовок Authorization: Api-Key <YC_API_KEY>
 *
 * API асинхронный: сначала POST (возвращает id операции), затем polling
 * operation.api.cloud.yandex.net/operations/{id} до done=true.
 * Итоговый результат — base64-encoded XML в поле rawData.
 *
 * Корневой XML-элемент: <yandexsearch>
 */

import { XMLParser } from "fast-xml-parser";
import type {
  YandexSearchOptions,
  YandexSearchResponse,
  YandexSearchResult,
} from "./types.js";

/** Нормализует дату в формат YYYYMMDD для Yandex */
function normalizeDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  if (/^\d{8}$/.test(dateStr)) return dateStr;
  try {
    const d = new Date(dateStr);
    return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  } catch {
    return undefined;
  }
}

// =============================================================================
// Типы для распарсенного XML
// =============================================================================

interface YandexTitleObj {
  hlword?: string[];
  "#text"?: string;
}

interface YandexPassageObj {
  hlword?: string[];
  "#text"?: string;
}

interface YandexParsedDoc {
  "@_id"?: string;
  "@_url"?: string;
  url?: string;        // бывает и строкой
  domain?: string;
  title?: string | YandexTitleObj | YandexTitleObj[];
  passages?: {
    passage?: string | YandexPassageObj | YandexPassageObj[];
  };
  modtime?: string;   // "YYYYMMDDTHHmmss"
  "mime-type"?: string;
}

interface YandexParsedGroup {
  categ?: { "#text"?: string; "@_name"?: string };
  doc?: YandexParsedDoc | YandexParsedDoc[];
  doccount?: string;
  relevance?: unknown;
}

interface YandexParsedResponse {
  reqid?: string;
  found?: unknown;
  "found-docs"?: unknown;
  results?: {
    grouping?: YandexParsedGrouping | YandexParsedGrouping[];
  };
  grouping?: YandexParsedGrouping;
}

interface YandexParsedGrouping {
  page?: { "#text": number; "@_first"?: number; "@_last"?: number };
  group?: YandexParsedGroup | YandexParsedGroup[];
  "@_groups-on-page"?: number;
  "@_docs-in-group"?: number;
}

interface YandexParsedXml {
  "?xml"?: unknown;
  yandexsearch?: {
    request?: unknown;
    response?: YandexParsedResponse;
  };
}

// =============================================================================
// Парсинг XML
// =============================================================================

/** Убирает XML-теги (hlword и пр.) из строки, возвращает чистый текст */
function stripXmlTags(s: unknown): string {
  if (!s) return "";
  return String(s).replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/** Извлекает чистый текст из поля title (stopNodes возвращает raw XML строку) */
function extractTitle(raw: YandexParsedDoc["title"]): string {
  if (!raw) return "";
  if (typeof raw === "string") return stripXmlTags(raw);
  if (Array.isArray(raw)) return raw.map(extractTitle).join(" ").trim();
  // Объект { hlword: [...], "#text": "..." } — фоллбэк если stopNodes не сработал
  const text = raw["#text"] ?? "";
  return stripXmlTags(text);
}

/** Извлекает сниппет из passages (stopNodes возвращает raw XML строку) */
function extractPassage(raw: YandexParsedDoc["passages"]): string {
  if (!raw) return "";
  const passage = raw.passage;
  if (!passage) return "";
  if (typeof passage === "string") return stripXmlTags(passage);
  if (Array.isArray(passage)) {
    return passage.map(p => stripXmlTags(typeof p === "string" ? p : (p["#text"] ?? ""))).join(" ... ").trim();
  }
  // Объект — фоллбэк
  return stripXmlTags(passage["#text"] ?? "");
}

/** Парсит XML-ответ Yandex Search API v2 */
function parseYandexXmlResponse(xml: string): YandexSearchResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
    stopNodes: ["*.title", "*.passage"],
  });

  let parsed: YandexParsedXml;
  try {
    parsed = parser.parse(xml) as YandexParsedXml;
  } catch (err) {
    console.error("[YandexSearchProvider] Ошибка парсинга XML:", err);
    return [];
  }

  const resp = parsed?.yandexsearch?.response;
  if (!resp) {
    console.error("[YandexSearchProvider] Некорректный формат ответа: нет yandexsearch.response");
    return [];
  }

  // XML: response > results > grouping (может быть массив из одного элемента)
  const rawGrouping = resp.results?.grouping ?? resp.grouping;
  const grouping = Array.isArray(rawGrouping) ? rawGrouping[0] : rawGrouping;
  if (!grouping) {
    return [];
  }

  const results: YandexSearchResult[] = [];
  const groups = grouping.group ? (Array.isArray(grouping.group) ? grouping.group : [grouping.group]) : [];

  for (const group of groups) {
    const docs = group.doc ? (Array.isArray(group.doc) ? group.doc : [group.doc]) : [];

    for (const doc of docs) {
      // URL: бывает @_url или plain url (string)
      const url = doc["@_url"] ?? (typeof doc.url === "string" ? doc.url : "") as string;
      if (!url) continue;

      const title = extractTitle(doc.title);
      const description = extractPassage(doc.passages);
      const date = doc.modtime ? String(doc.modtime).trim() : undefined;
      const type = doc["mime-type"];

      results.push({ title, url, description, date, type });
    }
  }

  return results;
}

// =============================================================================
// Класс YandexSearchProvider
// =============================================================================

export class YandexSearchProvider {
  private readonly apiKey: string;
  private readonly folderId: string;
  private readonly searchUrl = "https://searchapi.api.cloud.yandex.net/v2/web/searchAsync";
  private readonly pollUrlBase = "https://operation.api.cloud.yandex.net/operations/";

  constructor(apiKey: string, folderId: string) {
    this.apiKey = apiKey;
    this.folderId = folderId;
  }

  async search(query: string, options: YandexSearchOptions = {}): Promise<YandexSearchResponse> {
    const { count = 10, language } = options;

    const body = JSON.stringify({
      query: {
        searchType: "SEARCH_TYPE_RU",
        queryText: query,
        familyMode: "FAMILY_MODE_NONE",
        page: 0,
      },
      sortSpec: {
        sortMode: "SORT_MODE_BY_RELEVANCE",
        sortOrder: "SORT_ORDER_DESC",
      },
      groupSpec: {
        groupMode: "GROUP_MODE_DEEP",
        groupsOnPage: count,
        docsInGroup: 1,
      },
      maxPassages: 2,
      region: "213",
      l10N: language === "en" ? "LOCALIZATION_EN" : "LOCALIZATION_RU",
      folderId: this.folderId,
    });

    const authHeaders = { "Authorization": "Api-Key " + this.apiKey };

    let opId: string | undefined;
    try {
      const response = await fetch(this.searchUrl, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const errorMsg = "Yandex API HTTP " + response.status + ": " + errorText;
        console.error("[YandexSearchProvider] " + errorMsg);
        return { results: [], error: errorMsg };
      }

      const opData = await response.json() as { id?: string; error?: string };
      if (!opData.id) {
        const errorMsg = "Нет id операции: " + JSON.stringify(opData);
        console.error("[YandexSearchProvider] " + errorMsg);
        return { results: [], error: errorMsg };
      }
      opId = opData.id;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[YandexSearchProvider] Ошибка запуска поиска: " + errorMsg);
      return { results: [], error: errorMsg };
    }

    const pollUrl = this.pollUrlBase + opId;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));

      try {
        const pollResp = await fetch(pollUrl, { headers: authHeaders });

        if (!pollResp.ok) {
          console.warn("[YandexSearchProvider] Polling HTTP " + pollResp.status + ", ждём...");
          continue;
        }

        const pollResult = await pollResp.json() as {
          done?: boolean;
          response?: { rawData?: string };
        };

        if (pollResult.done) {
          const rawData = pollResult.response?.rawData;
          if (!rawData) {
            return { results: [], error: "Операция завершена, но rawData пуста" };
          }
          const xmlBytes = Buffer.from(rawData, "base64");
          const xml = xmlBytes.toString("utf-8");
          const results = parseYandexXmlResponse(xml);
          return { results, total: results.length };
        }

      } catch (err) {
        console.warn("[YandexSearchProvider] Polling ошибка: " + err);
      }
    }

    return { results: [], error: "Таймаут: операция не завершилась за 30 секунд" };
  }
}


// =============================================================================
// Фабрика для регистрации в OpenClaw (контракт WebSearchProviderPlugin)
// =============================================================================

export function createYandexSearchProviderPlugin(params: {
  apiKey: string;
  folderId: string;
}) {
  const { apiKey, folderId } = params;

  const provider = new YandexSearchProvider(apiKey, folderId);

  const credentialPath = "plugins.entries.yandex.config.webSearch.apiKey";

  return {
    id: "yandex",
    label: "Yandex Search",
    hint: "Поиск через Yandex Search API v2 · российские и мировые результаты",
    onboardingScopes: ["text-inference"] as const,
    requiresCredential: true,
    credentialLabel: "Yandex Cloud API Key",
    envVars: ["YC_API_KEY"],
    placeholder: "AQVN...",
    signupUrl: "https://cloud.yandex.ru/docs/search-api/",
    docsUrl: "https://cloud.yandex.ru/docs/search-api/concepts/overview",
    autoDetectOrder: 5,
    credentialPath,
    inactiveSecretPaths: [credentialPath],

    getCredentialValue: (_searchConfig?: Record<string, unknown>) => apiKey,
    setCredentialValue: (_target: Record<string, unknown>, _value: unknown) => { /* read-only */ },

    createTool: (_ctx) => ({
      description: "Выполняет веб-поиск через Yandex Search API v2. Возвращает структурированный список результатов с заголовками, URL и сниппетами.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Поисковый запрос" },
          count: { type: "number", description: "Количество результатов (1-50)", minimum: 1, maximum: 50, default: 10 },
          country: { type: "string", description: "Код страны ISO 3166-1 alpha-2" },
          language: { type: "string", description: "Код языка ISO 639-1" },
          dateAfter: { type: "string", description: "Начало диапазона дат (ISO или YYYYMMDD)" },
          dateBefore: { type: "string", description: "Конец диапазона дат (ISO или YYYYMMDD)" },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>): Promise<unknown> {
        const result = await provider.search(args.query as string, {
          count: (args.count as number) || 10,
          country: args.country as string,
          language: args.language as string,
          dateAfter: args.dateAfter as string,
          dateBefore: args.dateBefore as string,
        });
        return { results: result.results, total: result.total, error: result.error };
      },
    }),
  };
}

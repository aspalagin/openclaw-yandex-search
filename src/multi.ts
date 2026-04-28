/**
 * Multi-Search Provider — параллельный merge Yandex + Brave
 *
 * Дёргает оба провайдера одновременно, дедуплицирует по нормализованному URL,
 * сортирует: сначала "both" (найдены обоими), затем чередуем yandex/brave.
 * Один упавший провайдер не убивает весь запрос — отдаём результаты живого.
 */

import type {
  YandexSearchResponse,
  YandexSearchResult,
  MultiSearchResult,
  MultiSearchOptions,
  YandexSearchOptions,
} from "./types.js";
import { YandexSearchProvider } from "./yandex.js";

// =============================================================================
// Нормализация URL для дедупликации
// =============================================================================

/**
 * Нормализует URL для сравнения при дедупликации:
 * - убирает www. в начале
 * - убирает trailing slash
 * - убирает utm_* и fbclid query-параметры
 */
/** Убирает HTML-теги и entities из строк Brave API */
function stripHtmlEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlForDedup(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // убираем www.
    let host = url.hostname.replace(/^www\./, "");
    // убираем trailing slash из pathname
    const path = url.pathname.replace(/\/$/, "");
    // убираем мусорные query-параметры
    const filteredParams = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (!/^(utm_|fbclid|gclid|yclid|mc_[a-z]|igshid|ref|mc_eid)$/i.test(k)) {
        filteredParams.set(k, v);
      }
    }
    const query = filteredParams.toString();
    return `${url.protocol}//${host}${path}${query ? "?" + query : ""}`;
  } catch {
    // Если URL невалидный — возвращаем as-is lowercased
    return rawUrl.toLowerCase().replace(/^www\./, "").replace(/\/$/, "");
  }
}

// =============================================================================
// Интерфейс провайдера (для generic-делегата)
// =============================================================================

interface SearchResultLike {
  title: string;
  url: string;
  description: string;
  date?: string;
  favicon?: string;
  type?: string;
}

interface ProviderLike {
  search(query: string, options?: YandexSearchOptions): Promise<YandexSearchResponse>;
}

// =============================================================================
// MultiSearchProvider
// =============================================================================

export class MultiSearchProvider {
  private readonly yandex: YandexSearchProvider;
  private readonly braveApiKey: string | null;
  private readonly braveBaseUrl = "https://api.search.brave.com/res/v1/web/search";
  private readonly maxResults: number;

  constructor(yandexApiKey: string, yandexFolderId: string, braveApiKey: string | null, maxResults = 10) {
    this.yandex = new YandexSearchProvider(yandexApiKey, yandexFolderId);
    this.braveApiKey = braveApiKey;
    this.maxResults = Math.max(maxResults, 10);
  }

  /**
   * Выполняет параллельный поиск через Yandex и Brave, мёржит результаты.
   */
  async search(query: string, options: MultiSearchOptions = {}): Promise<{ results: MultiSearchResult[]; errors: string[] }> {
    const count = options.count ?? this.maxResults;
    const errors: string[] = [];

    // Запускаем оба провайдера параллельно
    const [yandexResult, braveResult] = await Promise.allSettled([
      this.yandex.search(query, { count }),
      this.braveSearch(query, count),
    ]);

    let yandexResults: YandexSearchResult[] = [];
    let braveResults: SearchResultLike[] = [];

    if (yandexResult.status === "fulfilled") {
      yandexResults = yandexResult.value.results;
    } else {
      const msg = `Yandex Search упал: ${yandexResult.reason}`;
      console.warn(`[MultiSearchProvider] ${msg}`);
      errors.push(msg);
    }

    if (braveResult.status === "fulfilled") {
      braveResults = braveResult.value;
    } else {
      const msg = `Brave Search упал: ${braveResult.reason}`;
      console.warn(`[MultiSearchProvider] ${msg}`);
      errors.push(msg);
    }

    // Если оба упали — возвращаем пустой результат
    if (yandexResults.length === 0 && braveResults.length === 0) {
      return { results: [], errors };
    }

    // Дедупликация
    const merged = this.mergeResults(yandexResults, braveResults);

    return { results: merged.slice(0, count), errors };
  }

  // ---------------------------------------------------------------------------
  // Brave-поиск (встроенный, без импорта Brave-плагина)
  // ---------------------------------------------------------------------------

  private async braveSearch(query: string, count: number): Promise<SearchResultLike[]> {
    if (!this.braveApiKey) {
      console.warn("[MultiSearchProvider] Brave API key не задан, пропускаю Brave-поиск");
      return [];
    }

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
    });

    const response = await fetch(`${this.braveBaseUrl}?${params.toString()}`, {
      headers: {
        "Accept": "application/json",
        "X-Sw-Engine": "N2libmFjc2iBMdWNrIEVuZ2luZSAtIEJSTw==",
        "X-Subscription-Token": this.braveApiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Brave API HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
          type?: string;
          meta_url?: { favicon?: string };
        }>;
      };
    };

    return (data.web?.results ?? []).map((r) => ({
      title: stripHtmlEntities(r.title ?? ""),
      url: r.url ?? "",
      description: stripHtmlEntities(r.description ?? ""),
      date: r.age,
      favicon: r.meta_url?.favicon,
      type: r.type,
    }));
  }

  // ---------------------------------------------------------------------------
  // Merge + дедупликация
  // ---------------------------------------------------------------------------

  private mergeResults(
    yandexResults: YandexSearchResult[],
    braveResults: SearchResultLike[]
  ): MultiSearchResult[] {
    // Ключ = нормализованный URL
    type PartialResult = { source: "yandex" | "brave" | "both"; data: SearchResultLike };
    const urlMap = new Map<string, PartialResult>();

    for (const r of yandexResults) {
      const key = normalizeUrlForDedup(r.url);
      urlMap.set(key, { source: "yandex", data: r });
    }

    for (const r of braveResults) {
      const key = normalizeUrlForDedup(r.url);
      if (urlMap.has(key)) {
        // Уже есть — помечаем как "both"
        urlMap.set(key, { source: "both" as const, data: r });
      } else {
        urlMap.set(key, { source: "brave", data: r });
      }
    }

    // Преобразуем в массив
    const entries = Array.from(urlMap.entries());

    // Сортировка: "both" → чередование yandex/brave
    const both: Array<[string, PartialResult]> = [];
    const yandexOnly: Array<[string, PartialResult]> = [];
    const braveOnly: Array<[string, PartialResult]> = [];

    for (const entry of entries) {
      if (entry[1].source === 'both') both.push(entry);
      else if (entry[1].source === 'yandex') yandexOnly.push(entry);
      else if (entry[1].source === 'brave') braveOnly.push(entry);
    }

    // Чередуем yandexOnly и braveOnly
    const interleaved: Array<[string, PartialResult]> = [];
    const maxLen = Math.max(yandexOnly.length, braveOnly.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < yandexOnly.length) interleaved.push(yandexOnly[i]);
      if (i < braveOnly.length) interleaved.push(braveOnly[i]);
    }

    const final: MultiSearchResult[] = [
      ...both.map(([, v]) => ({ ...v.data, source: 'both' as const })),
      ...interleaved.map(([, v]) => ({ ...v.data, source: v.source as 'yandex' | 'brave' })),
    ];

    return final;
  }
}

// =============================================================================
// Фабрика для регистрации в OpenClaw (контракт WebSearchProviderPlugin)
// =============================================================================

export function createMultiSearchProviderPlugin(params: {
  yandexApiKey: string;
  yandexFolderId: string;
  braveApiKey: string | null;
  maxResults?: number;
}) {
  const { yandexApiKey, yandexFolderId, braveApiKey, maxResults = 10 } = params;

  const provider = new MultiSearchProvider(yandexApiKey, yandexFolderId, braveApiKey, maxResults);

  return {
    id: 'multi',
    label: 'Multi-Search',
    hint: 'Параллельный поиск Yandex + Brave с дедупликацией',
    onboardingScopes: ['text-inference'] as const,
    requiresCredential: false,
    credentialLabel: "",
    envVars: [] as string[],
    placeholder: '',
    signupUrl: '',
    docsUrl: "",
    autoDetectOrder: 20,
    inactiveSecretPaths: ['plugins.entries.multi.config.webSearch.apiKey'],
    credentialPath: 'plugins.entries.multi.config.webSearch.apiKey',

    getCredentialValue: (_searchConfig?: Record<string, unknown>) => "",
    setCredentialValue: (_target: Record<string, unknown>, _value: unknown) => {},

    createTool: (_ctx) => ({
      description: 'Параллельный веб-поиск через Yandex Search API и Brave Search. Возвращает объединённые и дедуплицированные результаты с пометкой источника (yandex, brave или both).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          count: { type: 'number', description: 'Количество результатов', minimum: 1, maximum: 50, default: 10 },
          country: { type: 'string', description: 'Код страны ISO 3166-1 alpha-2' },
          language: { type: 'string', description: 'Код языка ISO 639-1' },
          dateAfter: { type: 'string', description: 'Начало диапазона дат (ISO или YYYYMMDD)' },
          dateBefore: { type: 'string', description: 'Конец диапазона дат (ISO или YYYYMMDD)' },
        },
        required: ['query'],
      },
      async execute(args: Record<string, unknown>): Promise<unknown> {
        const result = await provider.search(args.query as string, {
          count: (args.count as number) || maxResults,
          country: args.country as string,
          language: args.language as string,
          dateAfter: args.dateAfter as string,
          dateBefore: args.dateBefore as string,
        });
        return { results: result.results, errors: result.errors };
      },
    }),
  };
}

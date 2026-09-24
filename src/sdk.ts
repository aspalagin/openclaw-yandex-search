/**
 * Хелперы `openclaw/plugin-sdk/provider-web-search` с локальным запасным вариантом.
 *
 * Внутри Gateway модуль SDK есть всегда (node_modules/openclaw → установленный OpenClaw), и тогда кэш
 * поиска общий с ядром, а сообщения об ошибках параметров совпадают с официальными провайдерами.
 * Вне Gateway (CI, тесты без OpenClaw, `npm ci --omit=peer`) используется встроенная реализация
 * с той же семантикой, что и в OpenClaw 2026.9.x.
 */

import type { PluginLogger } from "./types.js";
import { errorMessage } from "./util.js";

/** type-алиасы, а не interface: ядро ждёт Record<string, unknown>, а интерфейсы без индексной сигнатуры ему не подходят. */
export type WebSearchTimeFilters = {
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
};

export type WebSearchFilterError = {
  error: string;
  message: string;
  docs?: string;
};

export interface TimeFilterInput {
  rawDateAfter?: string;
  rawDateBefore?: string;
  rawFreshness?: string;
  freshnessProvider?: string;
  docs?: string;
  invalidFreshnessMessage?: string;
  conflictingTimeFiltersMessage?: string;
  invalidDateAfterMessage?: string;
  invalidDateBeforeMessage?: string;
  invalidDateRangeMessage?: string;
}

export interface WebSearchSdk {
  buildSearchCacheKey(parts: ReadonlyArray<string | number | boolean | null | undefined>): string;
  readCachedSearchPayload<T extends Record<string, unknown> = Record<string, unknown>>(
    cacheKey: string,
    ttlMs?: number,
  ): (T & { cached: true }) | undefined;
  writeCachedSearchPayload(cacheKey: string, payload: Record<string, unknown>, ttlMs: number): void;
  resolveSearchCacheTtlMs(searchConfig?: Record<string, unknown>): number;
  resolveSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number;
  resolveSearchCount(value: unknown, fallback: number): number;
  readConfiguredSecretString(value: unknown, path: string): string | undefined;
  readStringParam(params: Record<string, unknown>, key: string, options?: { required?: boolean }): string | undefined;
  readPositiveIntegerParam(
    params: Record<string, unknown>,
    key: string,
    options?: { max?: number; message?: string },
  ): number | undefined;
  parseWebSearchTimeFilters(params: TimeFilterInput): WebSearchTimeFilters | WebSearchFilterError;
}

// =============================================================================
// Встроенная реализация
// =============================================================================

interface CacheEntry {
  value: Record<string, unknown>;
  storedAt: number;
  expiresAt: number;
}

const LOCAL_CACHE = new Map<string, CacheEntry>();
const MINUTE_MS = 60_000;
const DEFAULT_CACHE_TTL_MINUTES = 15;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_SEARCH_COUNT = 10;
const FRESHNESS_CODES: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
  pd: "pd",
  pw: "pw",
  pm: "pm",
  py: "py",
};
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DOCS = "https://docs.openclaw.ai/tools/web";

function isValidIsoDay(value: string): boolean {
  if (!ISO_DAY_RE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const localWebSearchSdk: WebSearchSdk = {
  buildSearchCacheKey(parts) {
    return parts.map((part) => (part === undefined || part === null ? "default" : String(part))).join(":").toLowerCase();
  },

  readCachedSearchPayload(cacheKey, ttlMs) {
    const entry = LOCAL_CACHE.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    const expiresAt = ttlMs === undefined ? entry.expiresAt : Math.min(entry.expiresAt, entry.storedAt + ttlMs);
    if (Date.now() >= expiresAt) {
      LOCAL_CACHE.delete(cacheKey);
      return undefined;
    }
    return { ...entry.value, cached: true } as never;
  },

  writeCachedSearchPayload(cacheKey, payload, ttlMs) {
    if (!(ttlMs > 0)) {
      return;
    }
    const now = Date.now();
    LOCAL_CACHE.set(cacheKey, { value: payload, storedAt: now, expiresAt: now + ttlMs });
  },

  resolveSearchCacheTtlMs(searchConfig) {
    const minutes = finiteNumber(searchConfig?.cacheTtlMinutes);
    return (minutes !== undefined && minutes >= 0 ? minutes : DEFAULT_CACHE_TTL_MINUTES) * MINUTE_MS;
  },

  resolveSearchTimeoutSeconds(searchConfig) {
    const seconds = finiteNumber(searchConfig?.timeoutSeconds);
    return seconds !== undefined && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS;
  },

  resolveSearchCount(value, fallback) {
    const candidate = finiteNumber(value) ?? fallback;
    return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(candidate)));
  },

  readConfiguredSecretString(value, path) {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "string") {
      return value.trim() || undefined;
    }
    if (typeof value === "object") {
      throw new Error(`${path}: значение задано объектом (SecretRef?), а не строкой; Gateway не подставил секрет`);
    }
    return String(value).trim() || undefined;
  },

  readStringParam(params, key, options) {
    const raw = params[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (options?.required) {
        throw new Error(`${key} required`);
      }
      return undefined;
    }
    return value;
  },

  readPositiveIntegerParam(params, key, options) {
    const raw = params[key];
    if (raw === undefined || raw === null || raw === "") {
      return undefined;
    }
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(value) || value <= 0 || (options?.max !== undefined && value > options.max)) {
      throw new Error(options?.message ?? `${key} must be a positive integer`);
    }
    return value;
  },

  parseWebSearchTimeFilters(params) {
    const docs = params.docs ?? DEFAULT_DOCS;
    const rawFreshness = params.rawFreshness?.trim();
    const freshness = rawFreshness ? FRESHNESS_CODES[rawFreshness.toLowerCase()] : undefined;
    if (rawFreshness && !freshness) {
      return { error: "invalid_freshness", message: params.invalidFreshnessMessage ?? "freshness must be day, week, month, or year.", docs };
    }
    const dateAfter = params.rawDateAfter?.trim() || undefined;
    const dateBefore = params.rawDateBefore?.trim() || undefined;
    if (rawFreshness && (dateAfter || dateBefore)) {
      return {
        error: "conflicting_time_filters",
        message: params.conflictingTimeFiltersMessage ?? "freshness and date_after/date_before cannot be used together.",
        docs,
      };
    }
    if (dateAfter && !isValidIsoDay(dateAfter)) {
      return { error: "invalid_date_after", message: params.invalidDateAfterMessage ?? "date_after must be YYYY-MM-DD format.", docs };
    }
    if (dateBefore && !isValidIsoDay(dateBefore)) {
      return { error: "invalid_date_before", message: params.invalidDateBeforeMessage ?? "date_before must be YYYY-MM-DD format.", docs };
    }
    if (dateAfter && dateBefore && dateAfter > dateBefore) {
      return { error: "invalid_date_range", message: params.invalidDateRangeMessage ?? "date_after must be before date_before.", docs };
    }
    return freshness ? { freshness } : { dateAfter, dateBefore };
  },
};

// =============================================================================
// Загрузка настоящего SDK
// =============================================================================

let sdkPromise: Promise<WebSearchSdk> | undefined;

/** Настоящий SDK OpenClaw, если он доступен; иначе встроенная реализация (с одним предупреждением в лог). */
export function loadWebSearchSdk(logger?: PluginLogger): Promise<WebSearchSdk> {
  sdkPromise ??= import("openclaw/plugin-sdk/provider-web-search")
    .then((module) => module as unknown as WebSearchSdk)
    .catch((err: unknown) => {
      logger?.warn(
        `[openclaw-yandex-search] SDK provider-web-search недоступен (${errorMessage(err)}); ` +
          "используется встроенная реализация кэша и разбора параметров",
      );
      return localWebSearchSdk;
    });
  return sdkPromise;
}

/** Для тестов: сбросить загруженный SDK и локальный кэш. */
export function resetWebSearchSdk(): void {
  sdkPromise = undefined;
  LOCAL_CACHE.clear();
}

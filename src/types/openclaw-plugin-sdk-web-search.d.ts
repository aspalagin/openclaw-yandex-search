/**
 * Минимальные типы для `openclaw/plugin-sdk/provider-web-search`: у этого subpath в SDK нет .d.ts.
 * Сигнатуры сверены с OpenClaw 2026.9.5 (dist/web-search-provider-common-*.mjs, dist/common-*.mjs).
 * Ambient-объявление: в рантайме Node берёт настоящий модуль из node_modules/openclaw.
 */

declare module "openclaw/plugin-sdk/provider-web-search" {
  export const DEFAULT_SEARCH_COUNT: number;
  export const MAX_SEARCH_COUNT: number;

  export function buildSearchCacheKey(parts: ReadonlyArray<string | number | boolean | null | undefined>): string;
  export function readCachedSearchPayload<T extends Record<string, unknown> = Record<string, unknown>>(
    cacheKey: string,
    ttlMs?: number,
  ): (T & { cached: true }) | undefined;
  export function writeCachedSearchPayload(cacheKey: string, payload: Record<string, unknown>, ttlMs: number): void;
  export function resolveSearchCacheTtlMs(searchConfig?: Record<string, unknown>): number;
  export function resolveSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number;
  export function resolveSearchCount(value: unknown, fallback: number): number;
  export function readConfiguredSecretString(value: unknown, path: string): string | undefined;
  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; trim?: boolean; label?: string; allowEmpty?: boolean },
  ): string | undefined;
  export function readPositiveIntegerParam(
    params: Record<string, unknown>,
    key: string,
    options?: { max?: number; message?: string },
  ): number | undefined;

  export interface WebSearchTimeFilters {
    freshness?: string;
    dateAfter?: string;
    dateBefore?: string;
  }

  export interface WebSearchFilterError {
    error: string;
    message: string;
    docs?: string;
  }

  export function parseWebSearchTimeFilters(params: {
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
  }): WebSearchTimeFilters | WebSearchFilterError;
}

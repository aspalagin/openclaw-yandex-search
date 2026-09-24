/**
 * Общие типы плагина openclaw-yandex-search.
 */

/**
 * Строка результата в формате, который принимает ядро OpenClaw на границе web_search.
 * Ядро оставляет только title, url, snippet, published и siteName; остальные поля отбрасывает.
 */
export interface SearchRow {
  title: string;
  url: string;
  snippet: string;
  /** Дата публикации в формате YYYY-MM-DD (другие форматы ядро отбрасывает). */
  published?: string;
  /** Имя сайта (hostname). */
  siteName?: string;
}

export type EngineId = "yandex" | "brave";

/** Нормализованные параметры одного поискового вызова, общие для движков. */
export interface EngineSearchParams {
  query: string;
  /** Сколько результатов запрашивать у движка. */
  count: number;
  /** Код страны ISO 3166-1 alpha-2 или undefined. */
  country?: string;
  /** Код языка ISO 639-1 или undefined. */
  language?: string;
  /** Код языка выдачи Brave (en, en-gb, ru, ...). */
  searchLang?: string;
  /** Локаль интерфейса Brave (en-US). */
  uiLang?: string;
  /** Свежесть в кодах Brave: pd, pw, pm или py. */
  freshness?: string;
  /** Нижняя граница даты публикации, YYYY-MM-DD. */
  dateAfter?: string;
  /** Верхняя граница даты публикации, YYYY-MM-DD. */
  dateBefore?: string;
  /** Внешний сигнал отмены от ядра. */
  signal?: AbortSignal;
  /** Бюджет времени на вызов движка, мс. */
  timeoutMs: number;
}

export interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type FetchLike = typeof fetch;

/** Состояние одного движка после вызова multi-search. */
export interface EngineStatus {
  state: "ok" | "failed" | "skipped";
  count: number;
  tookMs: number;
  detail?: string;
}

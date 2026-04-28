/**
 * Типы для Yandex Search API v2 и Multi-Search провайдера
 * Yandex Search API: https://cloud.yandex.ru/docs/search-api/
 */

export interface YandexSearchResult {
  /** Заголовок результата */
  title: string;
  /** URL страницы */
  url: string;
  /** Сниппет / описание */
  description: string;
  /** Дата документа (ISO) */
  date?: string;
  /** Иконка/фавиконка */
  favicon?: string;
  /** Тип документа (site, news, etc.) */
  type?: string;
}

export interface YandexSearchOptions {
  /** Текстовый запрос */
  query?: string;
  /** Количество результатов (1-50, default 10) */
  count?: number;
  /** Код страны (ISO 3166-1 alpha-2, например RU, US) */
  country?: string;
  /** Код языка (ISO 639-1, например ru, en) */
  language?: string;
  /** Фильтр по дате — начало диапазона (ISO date или YYYYMMDD) */
  dateAfter?: string;
  /** Фильтр по дате — конец диапазона (ISO date или YYYYMMDD) */
  dateBefore?: string;
}

export interface YandexSearchResponse {
  /** Результаты поиска */
  results: YandexSearchResult[];
  /** Общее число найденных документов */
  total?: number;
  /** Текст ошибки при неудаче */
  error?: string;
}

export interface YandexApiRawResponse {
  /** Корневой элемент ответа */
  yandexsearchresponse?: {
    responsecode?: string;
    relevance?: string;
    found?: Array<{ "@count": string; "@more": string }>;
    results?: {
      grouping?: Array<{
        attr?: string;
        doccount?: string;
        grpobjcount?: string;
        groups?: Array<{
          "@key": string;
          "@size": string;
          doc?: YandexApiRawDocument | YandexApiRawDocument[];
        }>;
      }>;
    };
  };
  response?: {
    "@code"?: string;
    "@error-code"?: string;
    "@error-message"?: string;
  };
}

export interface YandexApiRawDocument {
  /** URL документа */
  url?: { "@href": string; "@date": string };
  /** Домен */
  domain?: { "@name": string; "@flavor": string };
  /** Заголовок — строка или массив сегментов { text, hl } */
  title?: string | Array<{ _text: string; hl?: string }>;
  /** Сниппет */
  passage?: Array<{ _text: string; hl?: string }> | { _text: string; hl?: string };
  /** Метаданные — дата */
  meta?: { "@name": string; "@content": string } | Array<{ "@name": string; "@content": string }>;
  /** Иконка */
  mime_type?: string;
  /** Тип документа */
  doctype?: { "@subtype": string; "#text": string } | string;
}

/** Нормализованный результат с информацией об источнике */
export interface MultiSearchResult extends YandexSearchResult {
  source: "yandex" | "brave" | "both";
}

/** Опции для Multi-Search */
export interface MultiSearchOptions extends YandexSearchOptions {
  /** Максимальное число итоговых результатов */
  maxResults?: number;
}

/** Провайдер-делегат (для внутреннего использования) */
export interface SearchDelegate {
  search(query: string, options?: YandexSearchOptions): Promise<YandexSearchResponse>;
}

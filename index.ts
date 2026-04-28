/**
 * openclaw-yandex-search plugin
 *
 * Регистрирует два провайдера веб-поиска:
 *  - yandex  — Yandex Search API v2
 *  - multi   — Multi-Search (Yandex + Brave, параллельный, с дедупликацией)
 */

import { createYandexSearchProviderPlugin } from "./src/yandex.js";
import { createMultiSearchProviderPlugin } from "./src/multi.js";

const yandexApiKey = process.env.YC_API_KEY ?? "";
const yandexFolderId = process.env.YC_FOLDER_ID ?? "";
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY ?? null;

if (!yandexApiKey) {
  console.warn("[openclaw-yandex-search] ВНИМАНИЕ: YC_API_KEY не найден в окружении. Провайдер Yandex будет работать только при ручной установке apiKey.");
}
if (!yandexFolderId) {
  console.warn("[openclaw-yandex-search] ВНИМАНИЕ: YC_FOLDER_ID не найден в окружении.");
}

// Фабричные функции вызываются при загрузке плагина, а не при регистрации.
// Провайдеры будут созданы с ключами из окружения.
// Для гибкости — читаем ключи динамически при каждом register().
const yandexPlugin = createYandexSearchProviderPlugin({
  apiKey: yandexApiKey,
  folderId: yandexFolderId,
});

const multiPlugin = createMultiSearchProviderPlugin({
  yandexApiKey,
  yandexFolderId,
  braveApiKey,
  maxResults: 10,
});

// Реэкспорт типов
export type { YandexSearchResult, YandexSearchOptions, YandexSearchResponse, MultiSearchResult, MultiSearchOptions } from "./src/types.js";

const plugin = {
  id: "openclaw-yandex-search",
  name: "Yandex Search + Multi-Search",
  description: "Yandex Search API v2 как провайдер веб-поиска и Multi-Search враппер (Yandex + Brave)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      yandex: {
        type: "object",
        additionalProperties: false,
        properties: {
          apiKey: { type: ["string", "object", "null"] },
          folderId: { type: ["string", "null"] },
        },
      },
      multi: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxResults: { type: "number", minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
  },
  register(api: {
    runtime: unknown;
    registerWebSearchProvider: (provider: ReturnType<typeof createYandexSearchProviderPlugin>) => void;
    logger: { info: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void };
  }) {
    api.registerWebSearchProvider(yandexPlugin);
    api.registerWebSearchProvider(multiPlugin);
  },
};

export default plugin;

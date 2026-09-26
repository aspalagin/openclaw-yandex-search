/**
 * openclaw-yandex-search: провайдеры web_search для OpenClaw.
 *
 *  - yandex — Yandex Search API v2 (отложенный режим);
 *  - multi  — Yandex + Brave параллельно, с дедупликацией.
 *
 * Ключи читаются при каждом поиске (конфиг плагина → tools.web.search → окружение, включая *_FILE),
 * ошибки движков попадают в лог Gateway и, если упали все, в ответ инструмента.
 */

import { PLUGIN_ID } from "./src/env.js";
import {
  createMultiSearchProviderPlugin,
  createYandexSearchProviderPlugin,
  type WebSearchProviderShape,
} from "./src/providers.js";
import type { PluginLogger } from "./src/types.js";

export type { SearchRow } from "./src/types.js";

interface PluginRegisterApi {
  logger?: PluginLogger;
  pluginConfig?: Record<string, unknown>;
  registerWebSearchProvider: (provider: WebSearchProviderShape) => void;
}

const plugin = {
  id: PLUGIN_ID,
  name: "Yandex + Brave Search",
  description:
    "Yandex + Brave: параллельный веб-поиск по двум движкам с дедупликацией и учётом ошибок движков. Отдельно доступен провайдер Yandex Search API v2.",
  register(api: PluginRegisterApi) {
    const logger: PluginLogger = api.logger ?? console;
    const deps = { logger, pluginConfig: api.pluginConfig };
    api.registerWebSearchProvider(createYandexSearchProviderPlugin(deps));
    api.registerWebSearchProvider(createMultiSearchProviderPlugin(deps));
    logger.info(`[${PLUGIN_ID}] провайдеры web_search зарегистрированы: yandex, multi`);
  },
};

export default plugin;

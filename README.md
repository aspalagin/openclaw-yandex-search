# openclaw-yandex-search — Yandex + Brave для OpenClaw

Веб-поиск для OpenClaw сразу по двум движкам: **Яндекс и Brave** опрашиваются параллельно, результаты сливаются
в одну выдачу и дедуплицируются по нормализованному URL (провайдер `multi`). Если один движок упал или не настроен,
отвечает второй. Дополнительно в пакете есть одиночный провайдер `yandex` — Yandex Search API v2 без Brave.

**In English.** Yandex + Brave web search for OpenClaw: the `multi` provider queries both engines in parallel,
merges the results and removes duplicates, and keeps answering if one engine fails. A standalone `yandex` provider
(Yandex Search API v2) is included as well.

Провайдеры `web_search`:

- **`multi`** — Yandex + Brave параллельно, со слиянием и дедупликацией по нормализованному URL;
- **`yandex`** — Yandex Search API v2 (отложенный режим: `searchAsync` + опрос операции).

Версия 0.2.2 написана под контракт web_search ядра OpenClaw 2026.9.x (проверена на 2026.9.6).
История изменений — в [CHANGELOG.md](CHANGELOG.md).

## Как работает `multi`

- Оба движка опрашиваются одновременно, у каждого просится по 10 результатов, модели отдаётся `count` строк
  (по умолчанию 10; ядро всё равно режет выдачу до 10).
- Дедупликация: без схемы, `www.`/`m.`, завершающего слэша, `index.html` и трекинговых параметров (`utm_*`, `yclid`, `fbclid`, ...).
  Ссылки, найденные обоими движками, идут первыми, дальше чередование Яндекс/Brave.
- **Ошибки.** Упал один движок — отдаются результаты второго, в лог Gateway пишется `warn` с именем движка и запросом.
  Упали оба — инструмент возвращает `{ error: "provider_error", message }`, и модель видит ошибку, а не «ничего не найдено».
  Не настроен ни один ключ — `{ error: "missing_api_key" }`. Каждый поиск оставляет строку
  `[multi-search] yandex=N/ms brave=M/ms merged=K returned=R tookMs=T`.
- **Формат строк** — ровно то, что принимает ядро: `title`, `url`, `snippet`, `published` (YYYY-MM-DD), `siteName`.
  Строки без валидного http(s)-URL отбрасываются.
- **Фильтры.** Аргументы читаются в snake_case, как их передаёт ядро: `count`, `country`, `language`, `freshness`,
  `date_after`, `date_before`, `search_lang`, `ui_lang`.
  - Brave: `country`, `search_lang` (или `language`), `ui_lang`, `freshness` = `pd|pw|pm|py` либо диапазон `YYYY-MM-DDtoYYYY-MM-DD`.
  - Яндекс: `country` → `searchType` (RU/TR/KZ/BY/UZ, остальные → yandex.com), `language` → `l10n`,
    даты → поле `period` (сутки / 2 недели / месяц — ближайший период, накрывающий запрос).
    Диапазон, который периодами не выражается (старше месяца или с верхней границей в прошлом), Яндекс не получает:
    на такой запрос отвечает один Brave.
- **Таймауты и отмена.** Сигнал отмены ядра прокидывается во все запросы; бюджет времени берётся из
  `tools.web.search.timeoutSeconds` (по умолчанию 30 с). Опрос операции Яндекса: первый через 300 мс, дальше каждые 500 мс,
  на 4xx опрос прекращается, на 429/5xx и сетевых сбоях повторяется до дедлайна.
- **Кэш.** Результаты кэшируются на `tools.web.search.cacheTtlMinutes` (по умолчанию 15 минут) через SDK OpenClaw,
  а без него — через встроенную реализацию; ключ включает запрос, count и все фильтры. Неполные ответы не кэшируются.
- **Почему не синхронный режим Яндекса.** По тарифу Search API синхронный запрос примерно в 16 раз дороже отложенного
  (пример из документации: 250 000 синхронных = 122 000 ₽, 50 000 отложенных = 1 525 ₽). Секунда ожидания того не стоит.

## Ключи

Порядок поиска каждого значения (читается при каждом запросе, ротация не требует рестарта):

1. `tools.web.search.yandex.apiKey`, `tools.web.search.yandex.folderId`, `tools.web.search.brave.apiKey`;
2. `plugins.entries.openclaw-yandex-search.config.{yandex.apiKey, yandex.folderId, brave.apiKey}`;
3. окружение Gateway: `YC_API_KEY` (или файл из `YC_API_KEY_FILE`), `YC_FOLDER_ID`, `BRAVE_SEARCH_API_KEY` (или `BRAVE_API_KEY`).

Если не задан ни один ключ Brave, `multi` работает только через Яндекс, и наоборот.

## Установка

Пакет опубликован в ClawHub и npm под именем `@aspalagin/openclaw-yandex-search`
(id плагина в конфиге остаётся `openclaw-yandex-search`):

```bash
# из ClawHub
openclaw plugins install clawhub:@aspalagin/openclaw-yandex-search

# или из npm
openclaw plugins install npm:@aspalagin/openclaw-yandex-search
```

В неинтерактивном режиме OpenClaw может потребовать флаг `--accept-capabilities`, а для npm-источника ещё и `--force`.

Дальше настройте ключи и выберите провайдера:

1. Задайте ключи в окружении Gateway: `YC_API_KEY` и `YC_FOLDER_ID` (Яндекс), `BRAVE_SEARCH_API_KEY` (Brave).
   Вместо окружения ключи можно положить в конфиг, см. раздел «Ключи» выше.
2. Включите поиск по двум движкам:

   ```bash
   openclaw config set tools.web.search.provider multi
   ```

   Для поиска только через Яндекс укажите `yandex`.

## Установка из исходников

Альтернатива — клон репозитория как локального расширения OpenClaw:

```bash
git clone https://github.com/aspalagin/openclaw-yandex-search.git \
  ~/.openclaw/extensions/openclaw-yandex-search
cd ~/.openclaw/extensions/openclaw-yandex-search
npm ci --omit=peer
npm run build

# Сделать runtime OpenClaw доступным как peer dependency (SDK ядра: кэш и разбор параметров)
ln -sfn /usr/lib/node_modules/openclaw node_modules/openclaw
```

После обновления клона повторите `npm ci --omit=peer`, `npm run build` и проверьте симлинк. Каталог `dist/`
создаётся локально и не хранится в репозитории. Без симлинка плагин тоже работает: кэш и разбор параметров
берутся из встроенной реализации, о чём один раз сообщается в лог.

## Регистрация в openclaw.json

Пример для установки из исходников (при установке через `openclaw plugins install` блок `plugins.load.paths` не нужен):

```json
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/openclaw-yandex-search"] },
    "entries": {
      "openclaw-yandex-search": {
        "enabled": true,
        "config": {
          "yandex": { "apiKey": null, "folderId": null },
          "brave": { "apiKey": null },
          "multi": { "maxResults": 10 }
        }
      }
    },
    "allow": ["openclaw-yandex-search"]
  },
  "tools": { "web": { "search": { "provider": "multi" } } }
}
```

Применить новую версию кода без рестарта: `openclaw plugins reload openclaw-yandex-search`.

## Структура

```
index.ts                 точка входа: регистрирует провайдеры yandex и multi
src/env.ts               ключи из конфига и окружения (в т.ч. *_FILE)
src/yandex.ts            Yandex Search API v2: тело запроса, опрос операции, разбор XML, period
src/brave.ts             Brave Search API: параметры, повтор после 429, маппинг
src/multi.ts             склейка и дедупликация, статусы движков, логи
src/providers.ts         контракт провайдеров ядра, аргументы, кэш, таймауты
src/sdk.ts               ленивый доступ к SDK ядра со встроенной запасной реализацией
src/types/*.d.ts         типы для SDK-модуля provider-web-search (в SDK нет .d.ts)
test/*.test.mjs          node:test, поддельный fetch и фикстуры (test/fixtures)
scripts/smoke-*.mjs      живые проверки с ключами из окружения
```

## Проверки

```bash
npm run typecheck                 # TypeScript
npm test                          # оффлайн, без ключей и сети (через tsx, сборка не нужна)
npm run build                     # src → dist
npm run smoke:multi -- "запрос"   # живой прогон, ключи из окружения, значения ключей не печатаются
```

Правила вклада — в [CONTRIBUTING.md](CONTRIBUTING.md), политика безопасности — в [SECURITY.md](SECURITY.md).

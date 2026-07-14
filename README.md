# openclaw-yandex-search

Плагин OpenClaw, добавляющий **Yandex Search API v2** как провайдер веб-поиска и **Multi-Search** враппер (Yandex + Brave, параллельный, с дедупликацией).

## Структура файлов

```
openclaw-yandex-search/
├── package.json          # npm-пакет с extensions/ полем
├── tsconfig.json         # TypeScript конфиг
├── index.ts              # Точка входа плагина
├── openclaw.plugin.json  # Манифест плагина
├── src/
│   ├── types.ts          # Общие типы (YandexSearchResult, MultiSearchResult, etc.)
│   ├── yandex.ts          # YandexSearchProvider + фабрика плагина
│   └── multi.ts          # MultiSearchProvider + фабрика плагина
├── scripts/
│   ├── test-yandex.mjs   # Ручной тест YandexSearchProvider
│   └── test-multi.mjs    # Ручной тест MultiSearchProvider
└── test/                 # Unit-тесты с моками
```

## Провайдеры

### `yandex`
- **API**: Yandex Search API v2 (асинхронный: `POST searchAsync` → polling → base64 XML)
- **Endpoint**: `https://searchapi.api.cloud.yandex.net/v2/web/searchAsync`
- **Auth**: `Authorization: Api-Key <YC_API_KEY>`
- **Folder**: `YC_FOLDER_ID`
- **Параметры**: `query`, `count` (1-50), `language` (ru/en), `country`, `dateAfter`, `dateBefore`

### `multi`
- Параллельный поиск через **Yandex** и **Brave** одновременно
- Дедупликация по нормализованному URL (убрать `www.`, trailing `/`, `utm_*`, `fbclid`, etc.)
- Сортировка: сначала `both` (найдены обоими), затем чередование yandex/brave
- Graceful degradation: если один провайдер упал — возвращаются результаты второго

## Установка и поставка

Пакет не опубликован в npm (это проверяется перед релизом). Поддерживаемая
модель поставки — клон репозитория как локального расширения OpenClaw:

```bash
git clone https://github.com/aspalagin/openclaw-yandex-search.git \
  ~/.openclaw/extensions/openclaw-yandex-search
cd ~/.openclaw/extensions/openclaw-yandex-search
npm ci --omit=peer
npm run build

# Сделать runtime OpenClaw доступным как peer dependency после установки
ln -sf /usr/lib/node_modules/openclaw node_modules/openclaw
```

После обновления клона повторите `npm ci --omit=peer` и `npm run build`. Каталог `dist/`
создаётся локально и не хранится в репозитории. npm-публикация намеренно
заблокирована полем `private` в `package.json`.

## Регистрация в openclaw.json

```json
{
  "load": {
    "paths": [
      "~/.openclaw/extensions/openclaw-yandex-search"
    ]
  },
  "entries": {
    "openclaw-yandex-search": {
      "enabled": true,
      "config": {
        "yandex": {
          "apiKey": null,
          "folderId": null
        },
        "multi": {
          "maxResults": 10
        }
      }
    }
  },
  "allow": ["openclaw-yandex-search"]
}
```

## Переключение на multi как дефолтный провайдер

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "multi"
      }
    }
  }
}
```

## Переменные окружения

| Переменная        | Обязательно | Описание                    |
|-------------------|-------------|-----------------------------|
| `YC_API_KEY`      | Да          | Yandex Cloud API Key         |
| `YC_FOLDER_ID`    | Да          | Yandex Cloud Folder ID       |
| `BRAVE_SEARCH_API_KEY` | Нет (для multi) | Brave API Key (если не задан — multi работает только через Yandex) |

## Тесты

```bash
# Unit-тесты без внешних ключей и сети
npm test

# TypeScript-проверка и сборка
npm run typecheck
npm run build
```

Скрипты `test:yandex` и `test:multi` оставлены для ручной проверки реального
API: им требуются соответствующие ключи окружения. Правила вклада — в
[CONTRIBUTING.md](CONTRIBUTING.md), политика безопасности — в
[SECURITY.md](SECURITY.md), история изменений — в [CHANGELOG.md](CHANGELOG.md).

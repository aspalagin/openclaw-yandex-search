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
│   ├── test-yandex.mjs   # Тест YandexSearchProvider
│   └── test-multi.mjs    # Тест MultiSearchProvider
└── node_modules/
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

## Установка

```bash
cd ~/.openclaw/extensions/openclaw-yandex-search
npm install

# Добавить симлинк на openclaw (если ещё нет)
ln -sf /usr/lib/node_modules/openclaw node_modules/openclaw
```

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
# Тест Yandex-провайдера
node ./scripts/test-yandex.mjs

# Тест Multi-Search
node ./scripts/test-multi.mjs
```

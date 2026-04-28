# openclaw-yandex-search

OpenClaw plugin — **Yandex Search API v2** как провайдер веб-поиска и **Multi-Search** враппер, объединяющий Yandex + Brave Search с дедупликацией.

## Провайдеры

| ID | Название | Описание |
|----|----------|----------|
| `yandex` | Yandex Search | Прямой поиск через Yandex Search API v2 |
| `multi` | Multi-Search | Параллельный поиск Yandex + Brave, дедупликация, сортировка `both → yandex/brave` |

## Установка

### 1. Получите ключи

**Yandex Cloud Search API:**
1. Создайте облако и папку в [Yandex Cloud](https://console.cloud.yandex.ru)
2. Получите API-ключ: [Yandex Cloud → Search API](https://cloud.yandex.ru/docs/search-api/)
3. Скопируйте Folder ID из настроек папки

**Brave Search API** (опционально, для Multi-Search):
1. Получите ключ: [brave.com/search/api](https://brave.com/search/api/)

### 2. Настройте переменные окружения

```bash
export YC_API_KEY="your-yandex-api-key"
export YC_FOLDER_ID="your-yandex-folder-id"
export BRAVE_SEARCH_API_KEY="your-brave-api-key"  # опционально
```

### 3. Установите плагин

```bash
# Клонируйте в папку extensions
git clone https://github.com/aspalagin/openclaw-yandex-search.git \
  ~/.openclaw/extensions/openclaw-yandex-search
cd ~/.openclaw/extensions/openclaw-yandex-search
npm install
```

### 4. Настройте OpenClaw

В `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/.openclaw/extensions/openclaw-yandex-search"
      ]
    },
    "entries": {
      "openclaw-yandex-search": {
        "enabled": true,
        "config": {
          "multi": { "maxResults": 10 }
        }
      }
    },
    "allow": ["openclaw-yandex-search", ...]
  },
  "tools": {
    "web": {
      "search": {
        "provider": "multi"
      }
    }
  }
}
```

### 5. Перезапустите gateway

```bash
systemctl restart openclaw-gateway.service
```

## Использование

После активации провайдера `multi`, все вызовы `web_search` будут использовать параллельный поиск Yandex + Brave:

```
web_search("Сбербанк последние новости")
→ yandex: АФК «Система»: последние новости - Коммерсантъ
→ brave:  АФК «Система» - последние новости сегодня - РИА Новости
→ both:   Дубликаты объединяются, помечаются флагом source: "both"
```

## API-параметры

### Yandex Search (`yandex`)

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `query` | string | — | Поисковый запрос |
| `count` | number | 10 | Количество результатов (1–50) |
| `country` | string | RU | Код страны ISO 3166-1 alpha-2 |
| `language` | string | ru | Код языка ISO 639-1 |
| `dateAfter` | string | — | Начало диапазона дат |
| `dateBefore` | string | — | Конец диапазона дат |

### Multi-Search (`multi`)

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `query` | string | — | Поисковый запрос |
| `count` | number | 10 | Количество результатов |
| `country` | string | — | Код страны |
| `language` | string | — | Код языка |
| `dateAfter` | string | — | Начало диапазона дат |
| `dateBefore` | string | — | Конец диапазона дат |

## Разработка

```bash
npm install
npm run typecheck   # проверка TypeScript
npm run test:yandex  # тест Yandex API
npm run test:multi   # тест Multi-Search
```

## Структура

```
src/
  yandex.ts   — YandexSearchProvider (async API v2)
  multi.ts    — MultiSearchProvider (merge + dedup)
  types.ts    — общие типы
index.ts      — plugin entry point
```

## Лицензия

MIT

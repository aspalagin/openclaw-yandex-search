/**
 * Живой smoke-тест Yandex Search API: node scripts/smoke-yandex.mjs "запрос"
 * Ключи берутся из окружения (YC_API_KEY или YC_API_KEY_FILE, YC_FOLDER_ID) и не печатаются.
 * Запуск через tsx, сборка не нужна: npm run smoke:yandex -- "запрос".
 */
import { resolveCredentials } from "../src/env.ts";
import { searchYandex } from "../src/yandex.ts";

const query = process.argv.slice(2).join(" ") || "АФК Система последние новости";
const { yandexApiKey, yandexFolderId } = resolveCredentials();
if (!yandexApiKey || !yandexFolderId) {
  console.error("Нет YC_API_KEY (или YC_API_KEY_FILE) и YC_FOLDER_ID в окружении");
  process.exit(1);
}

const startedAt = Date.now();
try {
  const rows = await searchYandex({ query, count: 10, timeoutMs: 30_000 }, { apiKey: yandexApiKey, folderId: yandexFolderId, logger: console });
  console.log(`Результатов: ${rows.length}, ${Date.now() - startedAt} мс`);
  for (const row of rows) {
    console.log(`- [${row.published ?? "без даты"}] ${row.title}\n  ${row.url}\n  ${row.snippet.slice(0, 140)}`);
  }
} catch (err) {
  console.error(`Ошибка за ${Date.now() - startedAt} мс: ${err.message}`);
  process.exit(2);
}

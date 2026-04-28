/**
 * Тест YandexSearchProvider
 * Запуск: node --input-type=module ./scripts/test-yandex.mjs
 */

import { YandexSearchProvider } from "../src/yandex.ts";

const apiKey = process.env.YC_API_KEY;
const folderId = process.env.YC_FOLDER_ID;

if (!apiKey || !folderId) {
  console.error("❌ Не заданы YC_API_KEY или YC_FOLDER_ID");
  process.exit(1);
}

const provider = new YandexSearchProvider(apiKey, folderId);

console.log("🔍 Yandex Search: «АФК Система последние новости»\n");

const result = await provider.search("АФК Система последние новости", {
  count: 10,
  language: "ru",
  country: "RU",
});

if (result.error) {
  console.error("❌ Ошибка:", result.error);
  process.exit(1);
}

console.log(`✅ Получено результатов: ${result.results.length}\n`);
for (const r of result.results.slice(0, 5)) {
  console.log(`📌 ${r.title}`);
  console.log(`   URL: ${r.url}`);
  console.log(`   ${r.description.slice(0, 120)}...`);
  console.log();
}

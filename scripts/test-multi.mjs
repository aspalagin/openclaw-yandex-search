/**
 * Тест MultiSearchProvider
 * Запуск: node --input-type=module ./scripts/test-multi.mjs
 */

import { MultiSearchProvider } from "../src/multi.ts";

const yandexApiKey = process.env.YC_API_KEY;
const yandexFolderId = process.env.YC_FOLDER_ID;
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

if (!yandexApiKey || !yandexFolderId) {
  console.error("❌ Не заданы YC_API_KEY или YC_FOLDER_ID");
  process.exit(1);
}

if (!braveApiKey) {
  console.warn("⚠️  BRAVE_SEARCH_API_KEY не задан — Multi-Search будет работать только через Yandex");
}

const provider = new MultiSearchProvider(yandexApiKey, yandexFolderId, braveApiKey, 15);

console.log("🔍 Multi-Search: «АФК Система последние новости»\n");

const result = await provider.search("АФК Система последние новости", {
  count: 15,
  language: "ru",
  country: "RU",
});

console.log(`✅ Итоговых результатов: ${result.results.length}`);
if (result.errors.length > 0) {
  console.log(`⚠️  Ошибки провайдеров: ${result.errors.join("; ")}`);
}

const sourceStats = { yandex: 0, brave: 0, both: 0 };
for (const r of result.results) sourceStats[r.source]++;

console.log(`📊 Статистика источников: yandex=${sourceStats.yandex}, brave=${sourceStats.brave}, both=${sourceStats.both}\n`);

for (const r of result.results.slice(0, 5)) {
  const src = r.source === "both" ? "🔄 both" : r.source === "yandex" ? "🔍 Yandex" : "🦁 Brave";
  console.log(`${src} ${r.title}`);
  console.log(`   URL: ${r.url}`);
  console.log(`   ${r.description.slice(0, 120)}...`);
  console.log();
}

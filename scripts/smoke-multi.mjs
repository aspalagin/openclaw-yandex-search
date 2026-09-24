/**
 * Живой smoke-тест Multi-Search: node scripts/smoke-multi.mjs "запрос" [--after=YYYY-MM-DD] [--freshness=day|week|month]
 * Ключи берутся из окружения (YC_API_KEY или YC_API_KEY_FILE, YC_FOLDER_ID, BRAVE_SEARCH_API_KEY) и не печатаются.
 * Запуск через tsx, сборка не нужна: npm run smoke:multi -- "запрос".
 */
import { resolveCredentials } from "../src/env.ts";
import { runMultiSearch } from "../src/multi.ts";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const query = args.filter((a) => !a.startsWith("--")).join(" ") || "АФК Система последние новости";
const freshnessMap = { day: "pd", week: "pw", month: "pm", year: "py" };

const credentials = resolveCredentials();
console.log(`yandex: ${credentials.yandexApiKey && credentials.yandexFolderId ? "ключ найден" : "ключа нет"}; brave: ${credentials.braveApiKey ? "ключ найден" : "ключа нет"}`);

const outcome = await runMultiSearch({
  params: { query, count: 10, timeoutMs: 30_000, dateAfter: flags.after, freshness: freshnessMap[flags.freshness] },
  returnCount: 10,
  credentials,
  logger: console,
});

console.log(JSON.stringify({ ok: outcome.ok, error: outcome.error, message: outcome.message, tookMs: outcome.tookMs, engines: outcome.engines }, null, 2));
for (const row of outcome.rows) {
  console.log(`- [${row.published ?? "без даты"}] ${row.title}\n  ${row.url}\n  ${row.snippet.slice(0, 140)}`);
}

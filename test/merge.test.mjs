import test from "node:test";
import assert from "node:assert/strict";
import { mergeRows, normalizeUrlForDedup } from "../src/multi.ts";

test("normalizeUrlForDedup: схема, www/m, слэш, index.html, трекинг и порядок параметров не влияют", () => {
  const key = normalizeUrlForDedup("https://www.example.com/path/?utm_source=x&b=2&a=1&yclid=9#top");
  assert.equal(key, "example.com/path?a=1&b=2");
  assert.equal(normalizeUrlForDedup("http://example.com/path?a=1&b=2"), key);
  assert.equal(normalizeUrlForDedup("https://m.site.ru/"), normalizeUrlForDedup("https://site.ru"));
  assert.equal(normalizeUrlForDedup("https://site.ru/index.html"), normalizeUrlForDedup("https://site.ru/"));
  assert.notEqual(normalizeUrlForDedup("https://site.ru/a"), normalizeUrlForDedup("https://site.ru/b"));
  assert.equal(normalizeUrlForDedup("not a url"), "not a url");
});

test("mergeRows: both первыми, затем чередование; длинный сниппет и дата Brave; невалидные URL отброшены", () => {
  const yandex = [
    { title: "Y1", url: "https://www.rbc.ru/a?utm_source=y", snippet: "короткий", published: "2026-09-10", siteName: "www.rbc.ru" },
    { title: "Y2", url: "https://yandex.only/1", snippet: "y2" },
    { title: "Y3", url: "https://yandex.only/2", snippet: "y3" },
    { title: "bad", url: "javascript:alert(1)", snippet: "x" },
  ];
  const brave = [
    { title: "B1", url: "https://brave.only/1", snippet: "b1" },
    { title: "B2", url: "http://rbc.ru/a", snippet: "заметно более длинный сниппет от Brave", published: "2026-09-11" },
  ];
  const merged = mergeRows(yandex, brave);
  assert.deepEqual(
    merged.map((row) => row.url),
    ["https://www.rbc.ru/a?utm_source=y", "https://yandex.only/1", "https://brave.only/1", "https://yandex.only/2"],
  );
  assert.equal(merged[0].title, "Y1");
  assert.equal(merged[0].snippet, "заметно более длинный сниппет от Brave");
  assert.equal(merged[0].published, "2026-09-11");
  assert.equal(merged[0].siteName, "www.rbc.ru");
});

test("mergeRows: пустые входы", () => {
  assert.deepEqual(mergeRows([], []), []);
  assert.equal(mergeRows([{ title: "a", url: "https://a.ru", snippet: "" }], []).length, 1);
});

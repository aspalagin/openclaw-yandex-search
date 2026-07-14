import assert from "node:assert/strict";
import test from "node:test";

import { MultiSearchProvider } from "../src/multi.js";
import { YandexSearchProvider } from "../src/yandex.js";

const xml = `<?xml version="1.0"?><yandexsearch><response><results><grouping><group><doc url="https://www.example.com/article/?utm_source=test"><title>First <hlword>result</hlword></title><passages><passage>Short <hlword>description</hlword></passage></passages></doc></group></grouping></results></response></yandexsearch>`;

test("YandexSearchProvider отправляет запрос и разбирает готовый XML", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return new Response(JSON.stringify({ id: "operation-1" }), { status: 200 });
    return new Response(JSON.stringify({ done: true, response: { rawData: Buffer.from(xml).toString("base64") } }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await new YandexSearchProvider("test-key", "folder-1").search("query", { count: 3 });
    assert.equal(result.error, undefined);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, "https://www.example.com/article/?utm_source=test");
    assert.equal(result.results[0].title, "First result");
    assert.equal(requests[0].init?.headers && (requests[0].init.headers as Record<string, string>).Authorization, "Api-Key test-key");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("MultiSearchProvider дедуплицирует одинаковые URL из Yandex и Brave", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("brave.com")) {
      return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/article", description: "Result" }] } }), { status: 200 });
    }
    if (value.includes("searchAsync")) return new Response(JSON.stringify({ id: "operation-2" }), { status: 200 });
    return new Response(JSON.stringify({ done: true, response: { rawData: Buffer.from(xml).toString("base64") } }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await new MultiSearchProvider("key", "folder", "brave-key").search("query");
    assert.equal(result.errors.length, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].source, "both");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

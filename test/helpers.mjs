import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name) {
  return readFileSync(path.join(here, "fixtures", name), "utf8");
}

export function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function textResponse(text, init = {}) {
  return new Response(text, { status: init.status ?? 500, headers: init.headers ?? {} });
}

/**
 * Поддельный fetch с маршрутизацией по URL.
 * handlers: [{ match: string | RegExp, handle: (url, init, callNumber) => Response | Promise<Response> }]
 */
export function createFakeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    }
    calls.push({ url, init });
    for (const handler of handlers) {
      const matched = typeof handler.match === "string" ? url.startsWith(handler.match) : handler.match.test(url);
      if (matched) {
        handler.calls = (handler.calls ?? 0) + 1;
        return handler.handle(url, init, handler.calls);
      }
    }
    throw new Error(`нет поддельного обработчика для ${url}`);
  };
  return { fetchImpl, calls };
}

export function collectLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    logger: {
      debug: (message) => lines.debug.push(message),
      info: (message) => lines.info.push(message),
      warn: (message) => lines.warn.push(message),
      error: (message) => lines.error.push(message),
    },
  };
}

/** Ответ операции Yandex Cloud: done=true с base64-XML либо ещё не готово. */
export function yandexOperation(xml, { done = true, id = "op-1" } = {}) {
  if (!done) {
    return { id, done: false };
  }
  return {
    id,
    done: true,
    response: {
      "@type": "type.googleapis.com/yandex.cloud.searchapi.v2.WebSearchResponse",
      rawData: Buffer.from(xml, "utf8").toString("base64"),
    },
  };
}

export const YANDEX_ASYNC = "https://searchapi.api.cloud.yandex.net/v2/web/searchAsync";
export const YANDEX_OPS = "https://operation.api.cloud.yandex.net/operations/";
export const BRAVE = "https://api.search.brave.com/res/v1/web/search";

/** Стандартный набор обработчиков: Яндекс отвечает через один опрос, Brave сразу. */
export function happyHandlers({ yandexXml, braveJson }) {
  return [
    { match: YANDEX_ASYNC, handle: () => jsonResponse({ id: "op-1", done: false }) },
    {
      match: YANDEX_OPS,
      handle: (_url, _init, call) => jsonResponse(call === 1 ? yandexOperation(yandexXml, { done: false }) : yandexOperation(yandexXml)),
    },
    { match: BRAVE, handle: () => jsonResponse(JSON.parse(braveJson)) },
  ];
}

export const fastYandex = { pollInitialDelayMs: 1, pollIntervalMs: 1 };

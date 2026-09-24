/**
 * Multi-Search: Yandex + Brave параллельно, дедупликация по нормализованному URL.
 *
 * Порядок выдачи: сначала ссылки, найденные обоими движками, затем чередование остальных.
 * Один упавший движок не ломает запрос: отдаём результаты живого и пишем warn в лог.
 * Если упали оба — возвращаем ошибку, а не пустой список.
 */

import type { Credentials } from "./env.js";
import type { EngineId, EngineSearchParams, EngineStatus, FetchLike, PluginLogger, SearchRow } from "./types.js";
import { searchBrave, type BraveEngineOptions } from "./brave.js";
import { resolveYandexPeriod, searchYandex, type YandexEngineOptions } from "./yandex.js";
import { abortReason, errorMessage, isHttpUrl, silentLogger, truncate } from "./util.js";

const TRACKING_PARAM_RE = /^(utm_\w*|fbclid|gclid|dclid|yclid|ysclid|msclkid|igshid|mc_cid|mc_eid|_openstat|ref|_ga|_gl)$/i;

/**
 * Ключ дедупликации: без схемы, www./m., завершающего слэша, index.html и трекинговых параметров;
 * оставшиеся параметры отсортированы.
 */
export function normalizeUrlForDedup(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    const path = url.pathname.replace(/\/+$/, "").replace(/\/index\.(html?|php)$/i, "");
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM_RE.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return `${host}${path}${query}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

interface MergeEntry {
  row: SearchRow;
  engines: Set<EngineId>;
}

/** Склеивает выдачи: both → чередование yandex/brave. Невалидные URL отбрасываются. */
export function mergeRows(yandexRows: SearchRow[], braveRows: SearchRow[]): SearchRow[] {
  const byKey = new Map<string, MergeEntry>();

  const add = (row: SearchRow, engine: EngineId) => {
    if (!isHttpUrl(row.url)) {
      return;
    }
    const key = normalizeUrlForDedup(row.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { row: { ...row }, engines: new Set([engine]) });
      return;
    }
    existing.engines.add(engine);
    existing.row.title = existing.row.title || row.title;
    if (row.snippet.length > existing.row.snippet.length) {
      existing.row.snippet = row.snippet;
    }
    // Brave отдаёт дату публикации, Яндекс — дату изменения страницы; публикация точнее.
    if (engine === "brave" && row.published) {
      existing.row.published = row.published;
    } else if (!existing.row.published && row.published) {
      existing.row.published = row.published;
    }
    if (!existing.row.siteName && row.siteName) {
      existing.row.siteName = row.siteName;
    }
  };

  for (const row of yandexRows) {
    add(row, "yandex");
  }
  for (const row of braveRows) {
    add(row, "brave");
  }

  const both: SearchRow[] = [];
  const yandexOnly: SearchRow[] = [];
  const braveOnly: SearchRow[] = [];
  for (const entry of byKey.values()) {
    if (entry.engines.size > 1) {
      both.push(entry.row);
    } else if (entry.engines.has("yandex")) {
      yandexOnly.push(entry.row);
    } else {
      braveOnly.push(entry.row);
    }
  }

  const interleaved: SearchRow[] = [];
  const longest = Math.max(yandexOnly.length, braveOnly.length);
  for (let i = 0; i < longest; i++) {
    if (i < yandexOnly.length) {
      interleaved.push(yandexOnly[i]);
    }
    if (i < braveOnly.length) {
      interleaved.push(braveOnly[i]);
    }
  }
  return [...both, ...interleaved];
}

export interface MultiSearchInput {
  /** Параметры движков; count здесь — сколько просить у каждого движка. */
  params: EngineSearchParams;
  /** Сколько строк вернуть после склейки. */
  returnCount: number;
  credentials: Credentials;
  logger?: PluginLogger;
  fetchImpl?: FetchLike;
  yandex?: Partial<Omit<YandexEngineOptions, "apiKey" | "folderId">>;
  brave?: Partial<Omit<BraveEngineOptions, "apiKey">>;
  now?: Date;
}

export interface MultiSearchOutcome {
  ok: boolean;
  rows: SearchRow[];
  tookMs: number;
  engines: Record<EngineId, EngineStatus>;
  /** true, если ни один задействованный движок не упал: такой ответ можно кэшировать. */
  complete: boolean;
  error?: string;
  message?: string;
}

const ENGINE_LABEL: Record<EngineId, string> = { yandex: "Yandex", brave: "Brave" };

function describeStatus(status: EngineStatus): string {
  if (status.state === "skipped") {
    return "skip";
  }
  return `${status.state === "ok" ? status.count : "fail"}/${status.tookMs}ms`;
}

export async function runMultiSearch(input: MultiSearchInput): Promise<MultiSearchOutcome> {
  const startedAt = Date.now();
  const logger = input.logger ?? silentLogger;
  const { params, credentials } = input;
  const engines: Record<EngineId, EngineStatus> = {
    yandex: { state: "skipped", count: 0, tookMs: 0 },
    brave: { state: "skipped", count: 0, tookMs: 0 },
  };

  const yandexReady = Boolean(credentials.yandexApiKey && credentials.yandexFolderId);
  const braveReady = Boolean(credentials.braveApiKey);
  if (!yandexReady) {
    engines.yandex.detail = "нет YC_API_KEY или YC_FOLDER_ID";
  }
  if (!braveReady) {
    engines.brave.detail = "нет BRAVE_SEARCH_API_KEY";
  }
  if (!yandexReady && !braveReady) {
    return {
      ok: false,
      rows: [],
      tookMs: Date.now() - startedAt,
      engines,
      complete: false,
      error: "missing_api_key",
      message:
        "web_search (multi): не настроен ни один поисковый движок. Нужны YC_API_KEY и YC_FOLDER_ID для Яндекса " +
        "и/или BRAVE_SEARCH_API_KEY для Brave: в окружении Gateway или в plugins.entries.openclaw-yandex-search.config.",
    };
  }

  // Яндекс фильтрует по дате только периодами; если диапазон он выразить не может, отвечает один Brave.
  const period = resolveYandexPeriod({
    freshness: params.freshness,
    dateAfter: params.dateAfter,
    dateBefore: params.dateBefore,
    now: input.now,
  });
  let runYandex = yandexReady;
  if (runYandex && period.coverage === "none") {
    if (braveReady) {
      runYandex = false;
      engines.yandex.detail = `фильтр по дате не выражается периодами Яндекса (${period.note}); отвечает Brave`;
    } else {
      logger.warn(`[multi-search] yandex: фильтр по дате не применён (${period.note}), Brave не настроен, выдача без фильтра`);
    }
  } else if (runYandex && period.note) {
    logger.debug?.(`[multi-search] yandex: period=${period.period} (${period.note})`);
  }

  const timed = async (engine: EngineId, run: () => Promise<SearchRow[]>): Promise<SearchRow[]> => {
    const t0 = Date.now();
    try {
      const rows = await run();
      engines[engine] = { state: "ok", count: rows.length, tookMs: Date.now() - t0 };
      return rows;
    } catch (err) {
      engines[engine] = { state: "failed", count: 0, tookMs: Date.now() - t0, detail: errorMessage(err) };
      throw err;
    }
  };

  const [yandexSettled, braveSettled] = await Promise.allSettled([
    runYandex
      ? timed("yandex", () =>
          searchYandex(params, {
            ...input.yandex,
            apiKey: credentials.yandexApiKey as string,
            folderId: credentials.yandexFolderId as string,
            fetchImpl: input.fetchImpl,
            logger,
            period: period.period,
          }),
        )
      : Promise.resolve<SearchRow[]>([]),
    braveReady
      ? timed("brave", () =>
          searchBrave(params, {
            ...input.brave,
            apiKey: credentials.braveApiKey as string,
            fetchImpl: input.fetchImpl,
            logger,
          }),
        )
      : Promise.resolve<SearchRow[]>([]),
  ]);

  if (params.signal?.aborted) {
    throw abortReason(params.signal);
  }

  const tookMs = Date.now() - startedAt;
  const queryLabel = truncate(params.query, 80);
  const engineIds: EngineId[] = ["yandex", "brave"];
  for (const engine of engineIds) {
    const status = engines[engine];
    if (status.state === "failed") {
      logger.warn(`[multi-search] ${engine} упал за ${status.tookMs} мс: ${status.detail} | запрос: «${queryLabel}»`);
    }
  }

  const executed = engineIds.filter((engine) => engines[engine].state !== "skipped");
  const failed = executed.filter((engine) => engines[engine].state === "failed");
  if (executed.length > 0 && failed.length === executed.length) {
    const message = failed.map((engine) => `${ENGINE_LABEL[engine]}: ${engines[engine].detail}`).join("; ");
    logger.error(`[multi-search] все движки упали (${tookMs} мс): ${message}`);
    return {
      ok: false,
      rows: [],
      tookMs,
      engines,
      complete: false,
      error: "provider_error",
      message: `web_search (multi): ${message}`,
    };
  }

  const yandexRows = yandexSettled.status === "fulfilled" ? yandexSettled.value : [];
  const braveRows = braveSettled.status === "fulfilled" ? braveSettled.value : [];
  const merged = mergeRows(yandexRows, braveRows);
  const rows = merged.slice(0, Math.max(1, input.returnCount));
  logger.info(
    `[multi-search] yandex=${describeStatus(engines.yandex)} brave=${describeStatus(engines.brave)} ` +
      `merged=${merged.length} returned=${rows.length} tookMs=${tookMs}`,
  );
  return { ok: true, rows, tookMs, engines, complete: failed.length === 0 };
}

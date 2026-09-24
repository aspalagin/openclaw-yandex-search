/**
 * Вспомогательные функции: ошибки движков, очистка разметки, даты, URL, таймауты и отмена.
 */

import type { PluginLogger } from "./types.js";

/** Ошибка одного поискового движка с понятным сообщением. */
export class EngineError extends Error {
  readonly engine: string;
  readonly status?: number;

  constructor(engine: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EngineError";
    this.engine = engine;
    this.status = options.status;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

/** Сообщение сетевой ошибки Node fetch вместе с причиной (ECONNRESET, ENOTFOUND и т. п.). */
export function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = (err as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  return causeText && causeText !== err.message ? `${err.message} (${causeText})` : err.message;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

function codePointToString(codePoint: number): string {
  return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
}

/** Убирает HTML/XML-теги и сущности, схлопывает пробелы. */
export function stripMarkup(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePointToString(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => codePointToString(Number(dec)))
    .replace(/&([a-z]+);/gi, (match: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T\d{4,6}.*)?$/;

/** Приводит дату к YYYY-MM-DD. Принимает ISO (2026-09-11T09:30:00) и формат Яндекса (20260911T093000). */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  const match = ISO_DATE_RE.exec(text) ?? COMPACT_DATE_RE.exec(text);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) {
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Причина отмены из сигнала или стандартный AbortError. */
export function abortReason(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("Поиск отменён", "AbortError");
}

/** Пауза, которую прерывает сигнал отмены. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface TimeoutSignal {
  signal: AbortSignal;
  /** Снимает таймер и подписку на внешний сигнал; вызывать по завершении запроса. */
  clear: () => void;
}

/**
 * Сигнал, который срабатывает по внешней отмене или по таймауту.
 * Свой таймер, а не AbortSignal.timeout: тот unref'нут и в процессе без других задач
 * (тесты с поддельным fetch) может вообще не сработать до завершения цикла событий.
 */
export function withTimeout(timeoutMs: number, signal?: AbortSignal): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Таймаут ${timeoutMs} мс`, "TimeoutError")),
    Math.max(1, Math.floor(timeoutMs)),
  );
  const onAbort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/**
 * Превращает исключение движка в EngineError. Внешнюю отмену возвращает как есть,
 * чтобы ядро отличало её от сбоя провайдера.
 */
export function toEngineError(
  engine: string,
  err: unknown,
  options: { externalSignal?: AbortSignal; timeoutMs: number },
): Error {
  if (err instanceof EngineError) {
    return err;
  }
  if (options.externalSignal?.aborted) {
    return abortReason(options.externalSignal);
  }
  if (isTimeoutError(err) || (err instanceof Error && err.name === "AbortError")) {
    return new EngineError(engine, `таймаут ${options.timeoutMs} мс`, { cause: err });
  }
  return new EngineError(engine, `сетевая ошибка: ${describeNetworkError(err)}`, { cause: err });
}

/** Тело ответа для сообщения об ошибке: без переносов, не длиннее max символов. */
export async function readResponseText(response: Response, max = 300): Promise<string> {
  try {
    return truncate((await response.text()).replace(/\s+/g, " ").trim(), max);
  } catch {
    return "";
  }
}

export const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

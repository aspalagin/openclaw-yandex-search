/**
 * Учётные данные плагина.
 *
 * Порядок поиска каждого значения:
 *  1. tools.web.search.<группа>.<ключ>  (scoped search config, приходит в createTool как ctx.searchConfig);
 *  2. plugins.entries.openclaw-yandex-search.config.<группа>.<ключ>  (живой конфиг, затем снимок из register(api));
 *  3. переменные окружения Gateway, включая вариант <NAME>_FILE с путём к файлу.
 *
 * Значения читаются при каждом поиске, поэтому ротация ключа не требует рестарта.
 */

import { readFileSync } from "node:fs";
import { localWebSearchSdk, type WebSearchSdk } from "./sdk.js";
import type { PluginLogger } from "./types.js";
import { errorMessage } from "./util.js";

export const PLUGIN_ID = "openclaw-yandex-search";

export const ENV_YANDEX_API_KEY = "YC_API_KEY";
export const ENV_YANDEX_FOLDER_ID = "YC_FOLDER_ID";
export const ENV_BRAVE_API_KEYS = ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"];

/** Читает переменную окружения либо файл, путь к которому лежит в `${name}_FILE`. */
export function readEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name]?.trim();
  if (direct) {
    return direct;
  }
  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }
  try {
    return readFileSync(filePath, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface Credentials {
  yandexApiKey?: string;
  yandexFolderId?: string;
  braveApiKey?: string;
}

export interface CredentialSources {
  /** tools.web.search из контекста createTool. */
  searchConfig?: Record<string, unknown>;
  /** Полный конфиг OpenClaw из контекста createTool. */
  config?: unknown;
  /** plugins.entries.<id>.config, как передано в register(api). */
  pluginConfig?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  /** SDK для разбора значений из конфига (SecretRef и т. п.); по умолчанию встроенная реализация. */
  sdk?: Pick<WebSearchSdk, "readConfiguredSecretString">;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** plugins.entries.<pluginId>.config из полного конфига OpenClaw. */
export function pluginEntryConfig(config: unknown, pluginId: string = PLUGIN_ID): Record<string, unknown> | undefined {
  const entries = asRecord(asRecord(asRecord(config)?.plugins)?.entries);
  return asRecord(asRecord(entries?.[pluginId])?.config);
}

function configuredString(
  sdk: Pick<WebSearchSdk, "readConfiguredSecretString">,
  value: unknown,
  path: string,
  logger?: PluginLogger,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  try {
    return sdk.readConfiguredSecretString(value, path) || undefined;
  } catch (err) {
    logger?.warn(`[${PLUGIN_ID}] не удалось прочитать ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function resolveCredentials(sources: CredentialSources = {}): Credentials {
  const env = sources.env ?? process.env;
  const sdk = sources.sdk ?? localWebSearchSdk;
  const entry = pluginEntryConfig(sources.config) ?? sources.pluginConfig;
  const pick = (group: string, key: string, envNames: string[]): string | undefined => {
    const scoped = asRecord(sources.searchConfig?.[group])?.[key];
    const entryValue = asRecord(entry?.[group])?.[key];
    return (
      configuredString(sdk, scoped, `tools.web.search.${group}.${key}`, sources.logger) ??
      configuredString(sdk, entryValue, `plugins.entries.${PLUGIN_ID}.config.${group}.${key}`, sources.logger) ??
      envNames.map((name) => readEnvValue(name, env)).find((value) => Boolean(value))
    );
  };
  return {
    yandexApiKey: pick("yandex", "apiKey", [ENV_YANDEX_API_KEY]),
    yandexFolderId: pick("yandex", "folderId", [ENV_YANDEX_FOLDER_ID]),
    braveApiKey: pick("brave", "apiKey", ENV_BRAVE_API_KEYS),
  };
}

/** plugins.entries.<id>.config.yandex.mode (auto | async | sync) либо undefined, если не задан. */
export function pluginYandexMode(config: unknown, pluginConfig?: Record<string, unknown>): unknown {
  const entry = pluginEntryConfig(config) ?? pluginConfig;
  return asRecord(entry?.yandex)?.mode;
}

/** plugins.entries.<id>.config.multi.maxResults, приведённое к диапазону 1–10, либо undefined. */
export function pluginMaxResults(config: unknown, pluginConfig?: Record<string, unknown>): number | undefined {
  const entry = pluginEntryConfig(config) ?? pluginConfig;
  const raw = asRecord(entry?.multi)?.maxResults;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.floor(raw))) : undefined;
}

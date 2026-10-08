/**
 * The one place the rest of the app asks for settings.
 *
 * `getSettings()` merges, in order of increasing priority: built-in defaults, environment
 * variables, then rows in `app_settings` (editable in the web UI). The result is cached for a
 * few seconds so a page load does not hit the database on every request, and cleared whenever
 * the settings page writes something.
 */

import { isDatabaseConfigured } from "@/lib/db";
import {
  buildResolvedSettings,
  builtinSettings,
  loadEnvSettings,
  maskSecret,
  OVERRIDABLE_KEYS,
  SECRET_KEYS,
  serializeSettingsValues,
  SETTING_LABELS,
  type EnvSettings,
  type OverridableKey,
  type ResolvedSettings,
  type RuntimeSettings,
} from "./schema";
import { readOverrides, type OverridesMap } from "./store";

const CACHE_MS = 5_000;

let cache: { at: number; resolved: ResolvedSettings } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * Settings for the current process. Never throws: if the database is unreachable the
 * environment settings are returned so the UI can explain what is wrong.
 */
export async function getSettings(): Promise<ResolvedSettings> {
  const envSettings = loadEnvSettings();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.resolved;

  let overrides: OverridesMap = {};
  if (isDatabaseConfigured()) {
    try {
      overrides = await readOverrides();
    } catch (error) {
      console.warn("could not read settings from the database:", error);
    }
  }

  const resolved = buildResolvedSettings(envSettings, overrides);
  cache = { at: Date.now(), resolved };
  return resolved;
}

export function getSettingsSync(): ResolvedSettings {
  const envSettings = loadEnvSettings();
  return buildResolvedSettings(envSettings, {});
}

export interface SettingsView {
  /** Every knob, with secrets masked and the source of each value. */
  settings: Record<OverridableKey, { value: string; source: "database" | "environment" | "default"; isSecret: boolean; label: string }>;
  env: Omit<EnvSettings, "appSecret" | "appPassword" | "workerSecret"> & {
    appPasswordSet: boolean;
    appSecretSet: boolean;
    workerSecretSet: boolean;
  };
  envProblems: string[];
  databaseConfigured: boolean;
  storageDriver: string;
}

export async function getSettingsView(): Promise<SettingsView> {
  const resolved = await getSettings();
  const builtin = serializeSettingsValues(builtinSettings());
  const values = serializeSettingsValues(resolved.values);

  const settings = {} as SettingsView["settings"];
  for (const key of OVERRIDABLE_KEYS) {
    const isSecret = SECRET_KEYS.includes(key);
    const raw = values[key] ?? "";
    const source: "database" | "environment" | "default" = resolved.overridden.includes(key)
      ? "database"
      : raw !== builtin[key]
        ? "environment"
        : "default";
    settings[key] = {
      value: isSecret ? maskSecret(raw) : raw,
      source,
      isSecret,
      label: SETTING_LABELS[key],
    };
  }


  const { appPassword, appSecret, workerSecret, ...rest } = resolved.env;
  return {
    settings,
    env: {
      ...rest,
      appPasswordSet: Boolean(appPassword),
      appSecretSet: Boolean(appSecret),
      workerSecretSet: Boolean(workerSecret),
    },
    envProblems: resolved.envProblems,
    databaseConfigured: isDatabaseConfigured(),
    storageDriver: resolved.env.storageDriver,
  };
}

/** Plain helper for the places that only need the values. */
export async function runtimeSettings(): Promise<{ values: RuntimeSettings; env: EnvSettings }> {
  const resolved = await getSettings();
  return { values: resolved.values, env: resolved.env };
}

/**
 * Settings for the Settings page, and the writes it performs.
 *
 *   GET    → every setting with its value, where the value came from, and the environment
 *   PATCH  → store one or more overrides in the database
 *   DELETE → drop one override (…?key=crf) or every override (…?key=all)
 */

import { getSettings, getSettingsView, invalidateSettingsCache } from "@/lib/settings";
import { coerceOverride, MAX_UPLOAD_MB, OVERRIDABLE_KEYS, type OverridableKey } from "@/lib/settings/schema";
import { deleteOverride, writeOverride } from "@/lib/settings/store";
import { fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { isDatabaseConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    const view = await getSettingsView();
    const { values } = await getSettings();
    return json({
      ok: true,
      ...view,
      limits: { maxUploadMb: MAX_UPLOAD_MB },
      effective: {
        crf: values.crf,
        preset: values.preset,
        maxInputMb: values.maxInputMb,
        inlineMaxInputMb: values.inlineMaxInputMb,
        inlineMaxSeconds: values.inlineMaxSeconds,
        workerMaxAttempts: values.workerMaxAttempts,
        telegramDelivery: values.telegramDelivery,
        telegramConfigured: Boolean(values.telegramBotToken),
      },
    });
  } catch (error) {
    return handleRouteError(error, "GET /api/config");
  }
}

export async function PATCH(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) {
      return fail("DATABASE_URL is not set, so settings cannot be stored", 400);
    }
    const body = await readJson<{ values?: Record<string, string> }>(request);
    const entries = Object.entries(body.values ?? {});
    if (entries.length === 0) return fail("no values to save");

    const saved: Record<string, string> = {};
    for (const [key, raw] of entries) {
      if (!OVERRIDABLE_KEYS.includes(key as OverridableKey)) return fail(`unknown setting: ${key}`);
      if (raw === undefined || raw === null) continue;
      if (raw === "") {
        await deleteOverride(key as OverridableKey); // an empty box means "use the default"
        continue;
      }
      try {
        const value = coerceOverride(key as OverridableKey, String(raw));
        await writeOverride(key as OverridableKey, String(value));
        saved[key] = String(value === "" ? "" : value);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), 400);
      }
    }

    invalidateSettingsCache();
    const view = await getSettingsView();
    return json({ ok: true, saved, settings: view.settings });
  } catch (error) {
    return handleRouteError(error, "PATCH /api/config");
  }
}

export async function DELETE(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);
    const key = new URL(request.url).searchParams.get("key") ?? "";
    if (!key) return fail("which setting? add ?key=crf or ?key=all");

    if (key === "all") {
      const { clearOverrides } = await import("@/lib/settings/store");
      const count = await clearOverrides();
      invalidateSettingsCache();
      return json({ ok: true, cleared: count });
    }
    if (!OVERRIDABLE_KEYS.includes(key as OverridableKey)) return fail(`unknown setting: ${key}`);
    await deleteOverride(key as OverridableKey);
    invalidateSettingsCache();
    return json({ ok: true, cleared: 1 });
  } catch (error) {
    return handleRouteError(error, "DELETE /api/config");
  }
}

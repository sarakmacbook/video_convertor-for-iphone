/**
 * Reading and writing the editable settings that live in the `app_settings` table.
 *
 * Nothing here throws when the database is missing: an installation without `DATABASE_URL`
 * still reports its environment settings, it just cannot store overrides.
 */

import { getDb, isDatabaseConfigured, migrateToLatest } from "@/lib/db";
import type { OverridableKey } from "./schema";

export type OverridesMap = Partial<Record<OverridableKey, string>>;

export async function readOverrides(): Promise<OverridesMap> {
  if (!isDatabaseConfigured()) return {};
  const db = getDb();
  await migrateToLatest(db);
  const rows = await db.selectFrom("app_settings").select(["key", "value"]).execute();
  const result: OverridesMap = {};
  for (const row of rows) {
    result[row.key as OverridableKey] = row.value;
  }
  return result;
}

export async function writeOverride(key: OverridableKey, value: string): Promise<void> {
  const db = getDb();
  await migrateToLatest(db);
  const updated_at = new Date().toISOString();
  const existing = await db
    .selectFrom("app_settings")
    .select("key")
    .where("key", "=", key)
    .executeTakeFirst();

  if (existing) {
    await db.updateTable("app_settings").set({ value, updated_at }).where("key", "=", key).execute();
  } else {
    await db.insertInto("app_settings").values({ key, value, updated_at }).execute();
  }
}

export async function deleteOverride(key: OverridableKey): Promise<void> {
  const db = getDb();
  await migrateToLatest(db);
  await db.deleteFrom("app_settings").where("key", "=", key).execute();
}

export async function clearOverrides(): Promise<number> {
  const db = getDb();
  await migrateToLatest(db);
  const result = await db.deleteFrom("app_settings").executeTakeFirst();
  return Number(result?.numDeletedRows ?? 0);
}

/**
 * "Test this" buttons on the Settings page: database, storage, ffmpeg, Telegram.
 */

import { databaseStatus, testDatabaseConnection } from "@/lib/db";
import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { getSettings } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { uploadLimitBytes, telegramClientFor, telegramConfigured } from "@/lib/telegram/delivery";
import { baseUrl } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TestRequest {
  target?: "database" | "storage" | "ffmpeg" | "telegram";
  url?: string;
  chatId?: number | null;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    const body = await readJson<TestRequest>(request).catch(() => ({}) as TestRequest);
    const { values: settings } = await getSettings();

    switch (body.target) {
      case "database": {
        if (body.url?.trim()) {
          const result = await testDatabaseConnection(body.url);
          return json(result);
        }
        const status = await databaseStatus();
        return json({
          ok: status.connected,
          detail: status.connected
            ? `${status.dialect} reachable${status.serverVersion ? ` — ${status.serverVersion}` : ""}; ${status.tables.map((t) => `${t.name} (${t.rows ?? "?"})`).join(", ")}`
            : (status.error ?? "not connected"),
          status,
        });
      }
      case "storage": {
        const storage = getStorage({ baseUrl: baseUrl(request) });
        const result = await storage.test();
        return json({ ok: result.ok, detail: `${storage.label}: ${result.detail}` });
      }
      case "ffmpeg": {
        const status = await ffmpegStatus();
        return json({
          ok: status.available,
          detail: status.available
            ? `${status.version} (${status.source}${status.ffprobePath ? ", ffprobe available" : ", no ffprobe — using ffmpeg to inspect files"})`
            : status.problems.join(" "),
          status,
        });
      }
      case "telegram": {
        if (!telegramConfigured(settings)) {
          return fail("no Telegram bot token is configured", 400);
        }
        const client = telegramClientFor(settings);
        const me = await client.getMe();
        const info = await client.getWebhookInfo();
        let sent: string | null = null;
        if (body.chatId) {
          await client.sendMessage(
            body.chatId,
            "✅ This is a test message from your video converter. Everything is wired up.",
          );
          sent = `sent a test message to ${body.chatId}`;
        }
        return json({
          ok: true,
          detail: `@${me.username ?? me.first_name} · webhook ${info.url ? info.url : "not set"} · upload limit ${(uploadLimitBytes(settings) / 1_000_000).toFixed(0)} MB${sent ? ` · ${sent}` : ""}`,
          bot: me,
          webhook: info,
        });
      }
      default:
        return fail("target must be database, storage, ffmpeg or telegram");
    }
  } catch (error) {
    return handleRouteError(error, "POST /api/config/test");
  }
}

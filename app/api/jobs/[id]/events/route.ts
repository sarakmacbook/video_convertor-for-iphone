/**
 * The activity log of one job — the "what happened exactly?" view on the job page.
 */

import { isDatabaseConfigured } from "@/lib/db";
import { fail, handleRouteError, isAuthorized, json, unauthorized } from "@/lib/http";
import { getJob, listEvents } from "@/lib/jobs/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);

    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 200) || 200, 500);
    return json({ ok: true, events: await listEvents(job.id, limit) });
  } catch (error) {
    return handleRouteError(error, "GET /api/jobs/[id]/events");
  }
}

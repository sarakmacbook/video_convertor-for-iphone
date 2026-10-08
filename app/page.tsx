import { cookies } from "next/headers";

import { Converter } from "@/components/converter";
import { authRequired, sessionCookieName, verifySessionToken } from "@/lib/http";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const signedIn = !authRequired() || verifySessionToken(cookieStore.get(sessionCookieName())?.value);

  return (
    <main>
      <div className="page-head">
        <h1>Make an iPhone video smaller</h1>
        <p className="dim">
          Send the original file — HEVC output keeps the resolution, frame rate, HDR colour, audio and capture
          metadata. If re-encoding would not save anything, you get your original back.
        </p>
      </div>
      <Converter signedIn={signedIn} />
    </main>
  );
}

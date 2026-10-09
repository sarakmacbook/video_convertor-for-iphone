import { afterEach, describe, expect, it } from "vitest";

import { buildResolvedSettings, loadEnvSettings, MAX_UPLOAD_MB } from "@/lib/settings/schema";

afterEach(() => {
  delete process.env.TELEGRAM_API_URL;
  delete process.env.TELEGRAM_LOCAL_MODE;
});

describe("upload size cap", () => {
  it("is one gigabyte", () => {
    expect(MAX_UPLOAD_MB).toBe(1000);
  });

  it("local Bot API server defaults to the 1 GB cap, not 2000 MB", () => {
    process.env.TELEGRAM_LOCAL_MODE = "true";
    const resolved = buildResolvedSettings(loadEnvSettings(), {});
    expect(resolved.values.maxInputMb).toBe(MAX_UPLOAD_MB);
  });

  it("clamps a database override above 1 GB", () => {
    process.env.TELEGRAM_API_URL = "http://127.0.0.1:8081";
    const resolved = buildResolvedSettings(loadEnvSettings(), { max_input_mb: "2000" });
    expect(resolved.values.maxInputMb).toBe(MAX_UPLOAD_MB);
  });

  it("keeps a valid override below the cap", () => {
    const resolved = buildResolvedSettings(loadEnvSettings(), { max_input_mb: "500" });
    expect(resolved.values.maxInputMb).toBe(500);
  });
});

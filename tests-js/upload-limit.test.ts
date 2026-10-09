import { afterEach, describe, expect, it } from "vitest";

import {
  buildResolvedSettings,
  DEFAULT_LOCAL_INPUT_MB,
  loadEnvSettings,
  MAX_UPLOAD_MB,
} from "@/lib/settings/schema";

afterEach(() => {
  delete process.env.TELEGRAM_API_URL;
  delete process.env.TELEGRAM_LOCAL_MODE;
});

describe("upload size cap", () => {
  it("supports uploads up to two gigabytes", () => {
    expect(MAX_UPLOAD_MB).toBe(2000);
  });

  it("keeps the local Bot API default at one gigabyte", () => {
    process.env.TELEGRAM_LOCAL_MODE = "true";
    const resolved = buildResolvedSettings(loadEnvSettings(), {});
    expect(DEFAULT_LOCAL_INPUT_MB).toBe(1000);
    expect(resolved.values.maxInputMb).toBe(DEFAULT_LOCAL_INPUT_MB);
  });

  it("ignores a database override above the hard cap", () => {
    const resolved = buildResolvedSettings(loadEnvSettings(), { max_input_mb: "2500" });
    expect(resolved.values.maxInputMb).toBe(20);
    expect(resolved.overridden).not.toContain("max_input_mb");
  });

  it("accepts a larger database override up to the hard cap", () => {
    const resolved = buildResolvedSettings(loadEnvSettings(), { max_input_mb: "1500" });
    expect(resolved.values.maxInputMb).toBe(1500);
  });

  it("accepts the hard cap itself", () => {
    const resolved = buildResolvedSettings(loadEnvSettings(), { max_input_mb: "2000" });
    expect(resolved.values.maxInputMb).toBe(MAX_UPLOAD_MB);
  });
});

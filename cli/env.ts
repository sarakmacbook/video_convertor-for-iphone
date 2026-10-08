/**
 * Loading `.env` for the command-line tools (the web app lets Next.js do this itself).
 *
 * `.env` first, then `.env.local`, which wins — the same order Next.js uses, so one set of
 * files configures the app, the worker and the migration script.
 */

import { config } from "dotenv";

export function loadEnvFile(cwd = process.cwd()): void {
  config({ path: `${cwd}/.env`, quiet: true });
  config({ path: `${cwd}/.env.local`, override: true, quiet: true });
}

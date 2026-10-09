/**
 * Reading and updating .env files safely for local and CLI configuration.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const COMMENTED_ASSIGNMENT_RE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Format a key=value line, wrapping value in quotes if it contains spaces or shell characters.
 */
function formatEnvLine(key: string, value: string): string {
  if (value.includes(" ") || value.includes("&") || value.includes("#") || value.includes("{") || value.includes("}")) {
    if (!(value.startsWith('"') && value.endsWith('"')) && !(value.startsWith("'") && value.endsWith("'"))) {
      return `${key}="${value.replace(/"/g, '\\"')}"`;
    }
  }
  return `${key}=${value}`;
}

/**
 * Update KEY=value lines in .env text, replacing active lines or uncommenting placeholders,
 * while preserving every other line and comment.
 */
export function updateEnvText(text: string, updates: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  const written = new Set<string>();

  for (const line of lines) {
    const match = line.match(ASSIGNMENT_RE);
    const key = match ? match[1] : null;
    if (key && key in updates) {
      if (!written.has(key)) {
        result.push(formatEnvLine(key, updates[key]));
        written.add(key);
      }
      continue;
    }
    result.push(line);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (written.has(key)) continue;
    let replacedComment = false;
    for (let i = 0; i < result.length; i++) {
      const commented = result[i].match(COMMENTED_ASSIGNMENT_RE);
      if (commented && commented[1] === key) {
        result[i] = formatEnvLine(key, value);
        replacedComment = true;
        break;
      }
    }
    if (!replacedComment) {
      if (result.length > 0 && result[result.length - 1].trim() !== "") {
        result.push("");
      }
      result.push(formatEnvLine(key, value));
    }
    written.add(key);
  }

  return result.join("\n") + "\n";
}

/**
 * Save DATABASE_URL to .env (or create .env from .env.example) with mode 0600.
 */
export async function saveDatabaseUrlToEnv(
  databaseUrl: string,
  targetFile?: string,
): Promise<{ path: string; created: boolean }> {
  const root = process.cwd();
  const envPath = targetFile ? path.resolve(root, targetFile) : path.resolve(root, ".env");
  const examplePath = path.resolve(root, ".env.example");

  let existing = "";
  let created = false;

  try {
    existing = await fs.readFile(envPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      created = true;
      try {
        existing = await fs.readFile(examplePath, "utf-8");
      } catch {
        existing = "";
      }
    } else {
      throw err;
    }
  }

  const updated = updateEnvText(existing, { DATABASE_URL: databaseUrl });
  const tempPath = `${envPath}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, updated, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, envPath);

  return { path: envPath, created };
}

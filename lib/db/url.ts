/**
 * Work out which database a connection string points at.
 *
 * Supported forms (the database is chosen entirely by `DATABASE_URL`):
 *
 *   postgres://user:pass@host/db        PostgreSQL  (Neon, Vercel Postgres, Supabase, RDS, self-hosted)
 *   mysql://user:pass@host/db           MySQL       (PlanetScale, Aiven, RDS, self-hosted)
 *   mysql2://…                          same as mysql://
 *   libsql://db-name.turso.io?authToken=…   Turso (libSQL) over HTTP
 *   https://db-name.turso.io?authToken=…    Turso, HTTPS endpoint
 *   file:./.data/app.db                 SQLite file (local development, self-hosted, Docker volume)
 *   ./data/app.db  |  /var/lib/app.db   SQLite file, path form
 *
 * `sqlite://…` and `sqlite:…` are accepted as aliases of `file:` so that connection strings
 * copied from other tools still work.
 */

export type Dialect = "postgres" | "mysql" | "sqlite" | "libsql";

export interface DatabaseTarget {
  dialect: Dialect;
  /** Original connection string with any password/token hidden — safe to show in the UI. */
  display: string;
  /** Human-readable host or file path for the UI. */
  host: string;
  database: string;
  isLocalFile: boolean;
}

export class DatabaseUrlError extends Error {}

const SQLITE_PATH_SCHEMES = ["file:", "sqlite:", "sqlite3:"];

function stripScheme(raw: string, scheme: string): string {
  return raw.slice(scheme.length).replace(/^\/\//, "");
}

export function parseDatabaseUrl(raw: string | undefined | null): DatabaseTarget {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new DatabaseUrlError(
      "DATABASE_URL is not set. Point it at PostgreSQL, MySQL, SQLite or Turso — see docs/VERCEL.md.",
    );
  }

  const lower = value.toLowerCase();

  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
    const url = safeUrl(value);
    return {
      dialect: "postgres",
      display: redactUrl(value),
      host: url?.host ?? "unknown",
      database: url?.pathname.replace(/^\//, "") || "postgres",
      isLocalFile: false,
    };
  }

  if (lower.startsWith("mysql://") || lower.startsWith("mysql2://")) {
    const normalised = lower.startsWith("mysql2://") ? `mysql://${value.slice(9)}` : value;
    const url = safeUrl(normalised);
    return {
      dialect: "mysql",
      display: redactUrl(normalised),
      host: url?.host ?? "unknown",
      database: url?.pathname.replace(/^\//, "") || "mysql",
      isLocalFile: false,
    };
  }

  if (lower.startsWith("libsql://") || lower.startsWith("wss://") || lower.startsWith("ws://")) {
    const url = safeUrl(value);
    return {
      dialect: "libsql",
      display: redactUrl(value),
      host: url?.host ?? "unknown",
      database: url?.pathname.replace(/^\//, "") || "main",
      isLocalFile: false,
    };
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    // Turso also serves a plain HTTPS endpoint (https://<db>.turso.io) with ?authToken=…
    const url = safeUrl(value);
    const looksLikeTurso = /turso\.io|libsql/i.test(url?.host ?? "");
    if (!looksLikeTurso && !url?.searchParams.has("authToken")) {
      throw new DatabaseUrlError(
        "DATABASE_URL looks like a web address. Use postgres://, mysql://, libsql://, https://<db>.turso.io or a SQLite file path.",
      );
    }
    return {
      dialect: "libsql",
      display: redactUrl(value),
      host: url?.host ?? "unknown",
      database: url?.pathname.replace(/^\//, "") || "main",
      isLocalFile: false,
    };
  }

  for (const scheme of SQLITE_PATH_SCHEMES) {
    if (lower.startsWith(scheme)) {
      const path = stripScheme(value, value.slice(0, scheme.length));
      if (!path) throw new DatabaseUrlError(`DATABASE_URL has no file path after ${scheme}`);
      return {
        dialect: "sqlite",
        display: path,
        host: path,
        database: path.split("/").pop() || "app.db",
        isLocalFile: true,
      };
    }
  }

  if (lower.includes("://")) {
    const scheme = value.split("://")[0];
    throw new DatabaseUrlError(
      `DATABASE_URL uses the unsupported scheme "${scheme}://". Use postgres://, mysql://, libsql:// or a SQLite file path.`,
    );
  }

  // A bare path ("./.data/app.db", "/tmp/app.db", "app.db") is a SQLite file.
  return {
    dialect: "sqlite",
    display: value,
    host: value,
    database: value.split("/").pop() || "app.db",
    isLocalFile: true,
  };
}

/** Turso keeps its auth token in the connection string; libSQL wants it as a query parameter. */
export function libsqlConfig(raw: string): { url: string; authToken?: string } {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("sqlite:") || lower.startsWith("sqlite3:")) {
    return { url: `file:${stripScheme(value, value.slice(0, lower.indexOf(":") + 1))}` };
  }
  if (lower.startsWith("file:")) {
    return { url: value };
  }
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    // libSQL talks to Turso over WebSocket/HTTP; the SDK maps https:// to its own transport.
    return { url: value };
  }
  return { url: value };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function redactUrl(value: string): string {
  const url = safeUrl(value);
  if (!url) return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");
  if (url.password) url.password = "***";
  if (url.searchParams.has("authToken")) url.searchParams.set("authToken", "***");
  if (url.searchParams.has("password")) url.searchParams.set("password", "***");
  return url.toString();
}

/** Short label for the settings page ("PostgreSQL · db.example.com", "SQLite file · .data/app.db"). */
export function describeTarget(target: DatabaseTarget): string {
  switch (target.dialect) {
    case "postgres":
      return `PostgreSQL · ${target.host}/${target.database}`;
    case "mysql":
      return `MySQL · ${target.host}/${target.database}`;
    case "libsql":
      return `libSQL / Turso · ${target.host}`;
    default:
      return `SQLite file · ${target.database}`;
  }
}

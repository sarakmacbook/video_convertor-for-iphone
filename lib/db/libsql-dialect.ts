/**
 * A small Kysely dialect for libSQL (local SQLite files and Turso).
 *
 * Kysely ships dialects for PostgreSQL, MySQL and better-sqlite3, but not for the libSQL
 * client — and the libSQL client is the one package that covers both a local SQLite file
 * (`file:./.data/app.db`) and a hosted Turso database over HTTPS. libSQL is SQLite, so the
 * SQLite query compiler, adapter and introspector can be reused as-is; only the driver and
 * transaction calls are implemented here.
 */

import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type TransactionSettings,
} from "kysely";
import { createClient, type Client, type InValue } from "@libsql/client";

class LibsqlConnection implements DatabaseConnection {
  readonly #client: Client;
  readonly #close: (() => void) | undefined;

  constructor(client: Client, close?: () => void) {
    this.#client = client;
    this.#close = close;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#client.execute({
      sql: compiledQuery.sql,
      args: compiledQuery.parameters as InValue[],
    });
    // libSQL rows behave like objects and like arrays; Kysely wants plain objects.
    const rows = result.rows.map((row) => ({ ...row })) as R[];
    return {
      rows,
      numAffectedRows: BigInt(result.rowsAffected ?? 0),
      insertId: result.lastInsertRowid === undefined ? undefined : BigInt(result.lastInsertRowid),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("streamQuery is not implemented for libSQL; use executeQuery instead.");
  }

  release(): void {
    this.#close?.();
  }
}

class LibsqlDriver implements Driver {
  readonly #client: Client;
  /** libSQL has a single connection; transactions are serialised by the server. */
  #inTransaction = false;

  constructor(client: Client) {
    this.#client = client;
  }

  async init(): Promise<void> {
    // The libSQL client connects lazily.
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new LibsqlConnection(this.#client);
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    if (this.#inTransaction) throw new Error("a libSQL transaction is already open");
    this.#inTransaction = true;
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    if (!this.#inTransaction) throw new Error("no libSQL transaction is open");
    this.#inTransaction = false;
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    if (!this.#inTransaction) return;
    this.#inTransaction = false;
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.#client.close();
  }
}

export interface LibsqlDialectConfig {
  /** `file:./app.db`, `file::memory:`, `libsql://…` or the Turso HTTPS URL. */
  url: string;
  authToken?: string;
}

export class LibsqlDialect implements Dialect {
  readonly #config: LibsqlDialectConfig;

  constructor(config: LibsqlDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    const client = createClient({ url: this.#config.url, authToken: this.#config.authToken });
    return new LibsqlDriver(client);
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): SqliteIntrospector {
    return new SqliteIntrospector(db);
  }
}

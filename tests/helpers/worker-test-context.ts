import { D1Database as MiniflareD1Database, D1DatabaseAPI } from "@miniflare/d1";
import { createSQLiteDB } from "@miniflare/shared";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface WorkerTestEnv {
  DB: D1Database;
}

export interface WorkerTestContext {
  env: WorkerTestEnv;
  apiToken: string;
  cleanup: () => Promise<void>;
}

const migrationsDirectoryPath = path.resolve(process.cwd(), "drizzle/migrations");

const splitStatements = (sql: string): string[] => {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
};

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

export const createWorkerTestContext = async (): Promise<WorkerTestContext> => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tiny-cloudflare-todos-test-"));
  const sqlitePath = path.join(tempDir, "db.sqlite");
  const sqlite = await createSQLiteDB(sqlitePath);
  const d1Api = new D1DatabaseAPI(sqlite);
  const d1Database = new MiniflareD1Database({ fetch: d1Api.fetch.bind(d1Api) });

  const migrationFiles = (await readdir(migrationsDirectoryPath))
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const migrationFile of migrationFiles) {
    const migrationSql = await readFile(path.join(migrationsDirectoryPath, migrationFile), "utf8");
    for (const statement of splitStatements(migrationSql)) {
      const compactStatement = statement.replace(/\s+/g, " ").trim();
      await d1Database.exec(compactStatement);
    }
  }

  const apiToken = "test-token";
  const apiTokenHash = tokenHash(apiToken);
  await d1Database.exec(
    "INSERT OR REPLACE INTO users (id, email, display_name, active, created_at, updated_at) VALUES ('test-user', 'test@example.test', 'Test User', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);"
  );
  await d1Database.exec(
    `INSERT OR REPLACE INTO api_tokens (id, user_id, name, token_hash, last_used_at, revoked_at, created_at) VALUES ('test-token-id', 'test-user', 'test', '${apiTokenHash}', NULL, NULL, CURRENT_TIMESTAMP);`
  );

  return {
    env: {
      DB: d1Database as unknown as D1Database
    },
    apiToken,
    cleanup: async () => {
      sqlite.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
};

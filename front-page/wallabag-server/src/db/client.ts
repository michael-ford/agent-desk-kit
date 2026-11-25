import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config/index.js";
import * as schema from "./schema.js";

// Ensure data directory exists
mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

const sqlite: DatabaseType = new Database(config.DATABASE_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { sqlite };

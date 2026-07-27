import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Prevent unhandled 'error' events on idle pool clients (e.g. "terminating
// connection due to administrator command" during DB maintenance or publish)
// from crashing the Node process.  The pool will automatically reconnect.
pool.on("error", (err) => {
  console.error("[db-pool] idle client error (non-fatal):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";

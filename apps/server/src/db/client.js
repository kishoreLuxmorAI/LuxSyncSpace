import { neon } from "@neondatabase/serverless";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

const databaseUrl = new URL(config.databaseUrl);
const isLocalPostgres =
  databaseUrl.hostname === "localhost" ||
  databaseUrl.hostname === "127.0.0.1";

function createLocalSql() {
  const pool = new Pool({
    connectionString: config.databaseUrl
  });

  return async (strings, ...values) => {
  if (typeof strings === "string") {
    const result = await pool.query(strings);
    return result.rows;
  }

  const text = strings.reduce(
    (query, string, index) =>
      query + string + (index < values.length ? `$${index + 1}` : ""),
    ""
  );

  const result = await pool.query(text, values);
  return result.rows;
 };
}

export const sql = isLocalPostgres
  ? createLocalSql()
  : neon(config.databaseUrl);
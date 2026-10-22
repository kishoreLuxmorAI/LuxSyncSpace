import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

function createSql(queryable) {
  return async (strings, ...values) => {
    if (typeof strings === "string") {
      const result = await queryable.query(strings);
      return result.rows;
    }

    const text = strings.reduce(
      (query, string, index) =>
        query + string + (index < values.length ? `$${index + 1}` : ""),
      ""
    );

    const result = await queryable.query(text, values);
    return result.rows;
  };
}

export const sql = createSql(pool);

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(createSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
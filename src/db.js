'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Execute a query with optional parameters.
 * @param {string} text - SQL query string
 * @param {Array} [params] - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.debug('Executed query', { text: text.slice(0, 120), duration, rows: res.rowCount });
  }
  return res;
}

/**
 * Get a client from the pool for transactions.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

/**
 * Run a function inside a transaction, rolling back on error.
 * @param {function(import('pg').PoolClient): Promise<any>} fn
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify the database is reachable.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  const res = await pool.query('SELECT 1');
  return res.rowCount === 1;
}

module.exports = { query, getClient, withTransaction, healthCheck, pool };

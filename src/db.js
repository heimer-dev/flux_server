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

/**
 * Run all migrations idempotently on startup.
 * Uses IF NOT EXISTS / CREATE EXTENSION IF NOT EXISTS so it is safe to call
 * every time the app boots, even if the schema already exists.
 */
async function runMigrations() {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[db] Migrations applied successfully');
  } catch (err) {
    // Ignore "already exists" errors — tables/indexes were created in a prior run
    if (err.code === '42P07' || err.code === '42710') {
      console.log('[db] Migrations already applied, skipping');
    } else {
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, withTransaction, healthCheck, runMigrations, pool };

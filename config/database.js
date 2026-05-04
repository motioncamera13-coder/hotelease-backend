const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => console.log('✓ Database connected'));
pool.on('error', (err) => console.error('✗ Database error:', err.message));

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) console.warn(`⚠ Slow query (${duration}ms): ${text}`);
    return res;
  } catch (err) {
    console.error('✗ Query error:', err.message);
    throw err;
  }
}

async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient, pool };

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function setupDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Add it to .env or your hosting variables.');
  }

  const schemaPath = path.join(__dirname, '..', 'config', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('Setting up HotelEase PMS database...');
  await pool.query(sql);
  console.log('Database schema applied successfully.');
}

setupDb()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Database setup failed:', err.message);
    process.exit(1);
  });

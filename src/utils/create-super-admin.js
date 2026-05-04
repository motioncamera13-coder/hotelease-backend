require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../../config/database');

async function createSuperAdmin() {
  const username = process.argv[2] || 'superadmin';
  const password = process.argv[3] || 'HotelEase@2026';
  const name = process.argv[4] || 'Super Admin';

  console.log('Creating super admin...');
  console.log('Username:', username);
  console.log('Password:', password);

  const hash = await bcrypt.hash(password, 12);

  try {
    const result = await db.query(`
      INSERT INTO users (username, password_hash, name, role)
      VALUES ($1, $2, $3, 'super_admin')
      ON CONFLICT (username) DO UPDATE SET
        password_hash = $2, name = $3, role = 'super_admin'
      RETURNING id, username, name, role
    `, [username, hash, name]);

    console.log('✓ Super admin created:', result.rows[0]);
    console.log('\nLogin credentials:');
    console.log('Username:', username);
    console.log('Password:', password);
    process.exit(0);
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  }
}

createSuperAdmin();

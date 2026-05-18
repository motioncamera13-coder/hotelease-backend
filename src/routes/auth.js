const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'hotelease_secret_2026';

// Role permissions matrix
const ROLE_PERMISSIONS = {
  super_admin: {
    canSeeAllHotels: true,
    canManageHotels: true,
    canSeeRevenue: true,
    canManageStaff: true,
    canCreateBookings: true,
    canCheckInOut: true,
    canSeeRates: true,
    canManageRates: true,
    canSeeReports: true,
    canSeeAgents: true,
    canManageAgents: true,
    canSuspendHotels: true,
    canSeeSubscriptions: true,
    dashboard: 'super_admin'
  },
  hotel_owner: {
    canSeeAllHotels: false,
    canManageHotels: false,
    canSeeRevenue: true,
    canManageStaff: true,
    canCreateBookings: true,
    canCheckInOut: true,
    canSeeRates: true,
    canManageRates: true,
    canSeeReports: true,
    canSeeAgents: true,
    canManageAgents: true,
    canSuspendHotels: false,
    canSeeSubscriptions: false,
    dashboard: 'owner'
  },
  hotel_admin: {
    canSeeAllHotels: false,
    canManageHotels: false,
    canSeeRevenue: true,
    canManageStaff: false,
    canCreateBookings: true,
    canCheckInOut: true,
    canSeeRates: true,
    canManageRates: true,
    canSeeReports: true,
    canSeeAgents: true,
    canManageAgents: true,
    canSuspendHotels: false,
    canSeeSubscriptions: false,
    dashboard: 'admin'
  },
  staff: {
    canSeeAllHotels: false,
    canManageHotels: false,
    canSeeRevenue: false,
    canManageStaff: false,
    canCreateBookings: true,
    canCheckInOut: true,
    canSeeRates: false,
    canManageRates: false,
    canSeeReports: false,
    canSeeAgents: false,
    canManageAgents: false,
    canSuspendHotels: false,
    canSeeSubscriptions: false,
    dashboard: 'staff'
  },
  housekeeping: {
    canSeeAllHotels: false,
    canManageHotels: false,
    canSeeRevenue: false,
    canManageStaff: false,
    canCreateBookings: false,
    canCheckInOut: false,
    canSeeRates: false,
    canManageRates: false,
    canSeeReports: false,
    canSeeAgents: false,
    canManageAgents: false,
    canSuspendHotels: false,
    canSeeSubscriptions: false,
    dashboard: 'housekeeping'
  }
};

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user
    // Get user first
    const result = await db.query(
      "SELECT id, username, password_hash, name, role, hotel_id FROM users WHERE username = $1",
      [username]
    );
    
    // Get hotel details separately if needed
    let hotelName = null, city = null;
    if (result.rows[0]?.hotel_id) {
      try {
        const hotelResult = await db.query(
          "SELECT name, city FROM hotels WHERE id = $1",
          [result.rows[0].hotel_id]
        );
        hotelName = hotelResult.rows[0]?.name;
        city = hotelResult.rows[0]?.city;
      } catch(e) { console.log('Hotel lookup error:', e.message); }
    }
    
    // Merge hotel data
    if (result.rows[0]) {
      result.rows[0].hotel_name = hotelName;
      result.rows[0].city = city;
    }

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Hotel status check - skip if column doesn't exist yet

    const permissions = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.staff;

    // Generate token
    const token = jwt.sign(
      {
        userId: user.id,
        hotelId: user.hotel_id,
        role: user.role,
        username: user.username,
        permissions
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        hotelId: user.hotel_id,
        hotelName: user.hotel_name,
        city: user.city,
        permissions,
        dashboard: permissions.dashboard
      }
    });

  } catch (err) {
    console.error('Login error details:', err.message, err.stack);
    res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

// POST /api/auth/create-user — create staff/owner accounts
router.post('/create-user', async (req, res) => {
  try {
    const { username, password, name, role, hotelId } = req.body;

    // Validate role
    const allowedRoles = ['hotel_owner', 'hotel_admin', 'staff', 'housekeeping'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO users (id, username, password_hash, name, role, hotel_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
       RETURNING id, username, name, role, hotel_id`,
      [username, hash, name, role, hotelId]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users — get all users for a hotel
router.get('/users', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(
      `SELECT id, username, name, role, created_at FROM users
       WHERE hotel_id = $1 AND role != 'super_admin'
       ORDER BY role, name`,
      [hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auth/users/:id — update user
router.patch('/users/:id', async (req, res) => {
  try {
    const { name, password, role } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    }
    if (name) await db.query('UPDATE users SET name=$1 WHERE id=$2', [name, req.params.id]);
    if (role) await db.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/permissions — get permissions for a role
router.get('/permissions', async (req, res) => {
  try {
    const { hotelId, role } = req.query;
    if (!hotelId || !role) return res.status(400).json({ error: 'hotelId and role required' });

    const result = await db.query(
      `SELECT * FROM role_permissions WHERE hotel_id = $1 AND role = $2`,
      [hotelId, role]
    );

    if (result.rows.length === 0) {
      // Return default permissions if none saved
      return res.json({ success: true, data: null, isDefault: true });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    // Table might not exist yet
    if (err.code === '42P01') {
      return res.json({ success: true, data: null, isDefault: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/permissions — save permissions for a role
router.post('/permissions', async (req, res) => {
  try {
    const { hotelId, role, pages, permissions } = req.body;
    if (!hotelId || !role) return res.status(400).json({ error: 'hotelId and role required' });

    // Create table if not exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        hotel_id INTEGER NOT NULL,
        role VARCHAR(50) NOT NULL,
        pages JSONB NOT NULL DEFAULT '[]',
        permissions JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(hotel_id, role)
      )
    `);

    // Upsert permissions
    const result = await db.query(
      `INSERT INTO role_permissions (hotel_id, role, pages, permissions, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (hotel_id, role)
       DO UPDATE SET pages = $3, permissions = $4, updated_at = NOW()
       RETURNING *`,
      [hotelId, role, JSON.stringify(pages || []), JSON.stringify(permissions || {})]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/all-permissions — get permissions for all roles of a hotel
router.get('/all-permissions', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(
      `SELECT * FROM role_permissions WHERE hotel_id = $1 ORDER BY role`,
      [hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(oldPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Old password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, decoded.userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/roles — get all roles for a hotel
router.get('/roles', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(
      `SELECT DISTINCT role FROM users WHERE hotel_id = $1 AND role != 'super_admin' ORDER BY role`,
      [hotelId]
    );
    const defaultRoles = ['hotel_owner', 'hotel_admin', 'staff', 'housekeeping', 'captain', 'restaurant', 'garden', 'steward'];
    const dbRoles = result.rows.map(r => r.role);
    const allRoles = [...new Set([...dbRoles, ...defaultRoles])];
    res.json({ success: true, data: allRoles.map(r => ({ role: r, label: r.replace('_',' ').toUpperCase() })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

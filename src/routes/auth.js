const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'hotelease_secret_2026';

const operationalTablesToClear = [
  'requisition_items',
  'requisition_slips',
  'vouchers',
  'folio',
  'c_forms',
  'room_swaps',
  'cash_book',
  'bills',
  'payments',
  'extra_charges',
  'reservation_rooms',
  'reservations',
  'whatsapp_sessions',
  'activity_log',
  'guests',
  'agents',
];

function requireSuperAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only' });
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function tableExists(tableName) {
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return result.rows[0]?.exists === true;
}

async function summarizeOperational(hotelId = null) {
  const summary = {};
  for (const table of ['hotels', 'users', 'rooms', 'room_types', 'rates', 'reservations', 'guests', 'agents']) {
    if (!(await tableExists(table))) continue;
    const result = hotelId && ['rooms', 'room_types', 'rates', 'reservations', 'guests', 'agents'].includes(table)
      ? await db.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE hotel_id=$1`, [hotelId])
      : await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    summary[table] = result.rows[0].count;
  }
  return summary;
}

async function clearOperationalTable(client, tableName, hotelId = null) {
  if (!(await tableExists(tableName))) return { table: tableName, skipped: true, reason: 'missing' };

  if (hotelId) {
    if (tableName === 'reservation_rooms') {
      const result = await client.query(`
        DELETE FROM reservation_rooms rr
        USING reservations r
        WHERE rr.reservation_id = r.id AND r.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    if (['bills', 'payments', 'extra_charges'].includes(tableName)) {
      const result = await client.query(`
        DELETE FROM ${tableName} t
        USING reservations r
        WHERE t.reservation_id = r.id AND r.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    if (tableName === 'requisition_items') {
      const result = await client.query(`
        DELETE FROM requisition_items ri
        USING requisition_slips rs
        WHERE ri.requisition_id = rs.id AND rs.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    const result = await client.query(`DELETE FROM ${tableName} WHERE hotel_id = $1`, [hotelId]);
    return { table: tableName, deleted: result.rowCount };
  }

  const result = await client.query(`DELETE FROM ${tableName}`);
  return { table: tableName, deleted: result.rowCount };
}

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
  hotel_staff: {
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

function roomTypeForIndex(index, total) {
  const third = Math.ceil(total / 3);
  if (index < third) return 'Deluxe';
  if (index < third * 2) return 'Super Deluxe';
  return 'Honeymoon';
}

// POST /api/auth/register-hotel — create hotel, admin, room types and rooms
router.post('/register-hotel', async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      name, address, city, state, phone, email, gstin,
      whatsappBotNumber, adminPhone, totalRooms, bufferRooms,
      adminName, username, password
    } = req.body;

    if (!name || !city || !adminName || !username || !password) {
      return res.status(400).json({ error: 'name, city, adminName, username and password are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    await client.query('BEGIN');

    const hotelResult = await client.query(`
      INSERT INTO hotels (name, address, city, state, phone, email, gstin,
        whatsapp_bot_number, admin_phone, total_rooms, buffer_rooms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      name, address || null, city, state || null, phone || null, email || null, gstin || null,
      whatsappBotNumber || null, adminPhone || null,
      parseInt(totalRooms || 0, 10) || 0,
      parseInt(bufferRooms || 4, 10) || 4
    ]);
    const hotel = hotelResult.rows[0];

    const typeRows = {};
    for (const type of ['Deluxe', 'Super Deluxe', 'Honeymoon']) {
      const rt = await client.query(`
        INSERT INTO room_types (hotel_id, name, capacity)
        VALUES ($1, $2, 2)
        RETURNING *
      `, [hotel.id, type]);
      typeRows[type] = rt.rows[0];
    }

    const roomTotal = parseInt(totalRooms || 0, 10) || 0;
    for (let i = 0; i < roomTotal; i++) {
      const floor = Math.floor(i / 10) + 1;
      const roomNumber = `${floor}${String((i % 10) + 1).padStart(2, '0')}`;
      const type = roomTypeForIndex(i, roomTotal);
      await client.query(`
        INSERT INTO rooms (hotel_id, room_type_id, room_number, floor)
        VALUES ($1,$2,$3,$4)
      `, [hotel.id, typeRows[type].id, roomNumber, floor]);
    }

    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(`
      INSERT INTO users (hotel_id, username, password_hash, name, role)
      VALUES ($1,$2,$3,$4,'hotel_admin')
      RETURNING id, username, name, role, hotel_id
    `, [hotel.id, username, hash, adminName]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { hotel, admin: userResult.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Username, phone or another unique value already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/auth/hotels — super-admin hotel list
router.get('/hotels', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT h.*,
        COALESCE(COUNT(DISTINCT r.id), 0) as bookings,
        u.username as admin_username
      FROM hotels h
      LEFT JOIN reservations r ON r.hotel_id = h.id
      LEFT JOIN users u ON u.hotel_id = h.id AND u.role IN ('hotel_admin', 'hotel_owner')
      GROUP BY h.id, u.username
      ORDER BY h.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      "SELECT id, username, password_hash, name, role, hotel_id FROM users WHERE username = $1 AND is_active = true",
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
    const allowedRoles = [
      'hotel_owner', 'hotel_admin', 'hotel_staff', 'staff', 'housekeeping',
      'captain', 'restaurant', 'garden', 'steward', 'general_manager', 'gm', 'front_office'
    ];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO users (username, password_hash, name, role, hotel_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
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
      `SELECT id, username, name, role, is_active, created_at FROM users
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
    const { name, password, role, is_active, isActive } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    }
    if (name) await db.query('UPDATE users SET name=$1 WHERE id=$2', [name, req.params.id]);
    if (role) await db.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
    if (typeof is_active === 'boolean' || typeof isActive === 'boolean') {
      await db.query('UPDATE users SET is_active=$1 WHERE id=$2', [
        typeof is_active === 'boolean' ? is_active : isActive,
        req.params.id
      ]);
    }
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
    const userRoles = await db.query(
      `SELECT DISTINCT role FROM users WHERE hotel_id = $1 AND role != 'super_admin' ORDER BY role`,
      [hotelId]
    );
    let permissionRoles = [];
    try {
      const permResult = await db.query(
        `SELECT DISTINCT role FROM role_permissions WHERE hotel_id = $1 ORDER BY role`,
        [hotelId]
      );
      permissionRoles = permResult.rows.map(r => r.role);
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    const defaultRoles = ['captain', 'staff', 'garden', 'restaurant', 'general_manager', 'gm', 'steward', 'hotel_admin', 'housekeeping'];
    const dbRoles = userRoles.rows.map(r => r.role);
    const allRoles = [...new Set([...dbRoles, ...defaultRoles])];
    const labels = {
      hotel_owner: 'OWNER',
      hotel_admin: 'ADMIN',
      hotel_staff: 'FRONT OFFICE',
      staff: 'FRONT OFFICE',
      housekeeping: 'HOUSEKEEPING',
      captain: 'CAPTAIN',
      restaurant: 'RESTAURANT',
      garden: 'GARDEN',
      steward: 'STEWARD',
      general_manager: 'GENERAL MANAGER',
      gm: 'GM',
      front_office: 'FRONT OFFICE'
    };
    res.json({
      success: true,
      data: [...new Set([...allRoles, ...permissionRoles])].map(r => ({ role: r, label: labels[r] || r.replace(/_/g,' ').toUpperCase() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/reset-operational-data — super-admin fresh start reset
router.post('/reset-operational-data', requireSuperAdmin, async (req, res) => {
  const client = await db.getClient();
  try {
    const { hotelId = null, confirmText } = req.body || {};
    if (confirmText !== 'RESET PMS DATA') {
      return res.status(400).json({ error: 'Type RESET PMS DATA to confirm this reset' });
    }

    if (hotelId) {
      const hotel = await db.query('SELECT id, name FROM hotels WHERE id = $1', [hotelId]);
      if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' });
    }

    const before = await summarizeOperational(hotelId);
    await client.query('BEGIN');

    const deleted = [];
    for (const table of operationalTablesToClear) {
      deleted.push(await clearOperationalTable(client, table, hotelId));
    }

    let housekeeping = { skipped: true, reason: 'missing' };
    if (await tableExists('housekeeping')) {
      const result = hotelId
        ? await client.query('DELETE FROM housekeeping WHERE hotel_id=$1', [hotelId])
        : await client.query('DELETE FROM housekeeping');
      housekeeping = { deleted: result.rowCount };
    }

    const rooms = hotelId
      ? await client.query(`UPDATE rooms SET status='available' WHERE hotel_id=$1`, [hotelId])
      : await client.query(`UPDATE rooms SET status='available'`);

    await client.query('COMMIT');
    const after = await summarizeOperational(hotelId);

    res.json({
      success: true,
      scope: hotelId ? 'single_hotel' : 'all_hotels',
      hotelId: hotelId || null,
      before,
      deleted,
      housekeeping,
      rooms: { updated: rooms.rowCount },
      after,
      message: 'Operational data reset complete. Hotels, users, rooms, rates, and permissions were kept.'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

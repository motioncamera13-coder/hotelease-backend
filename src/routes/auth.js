const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'hotelease_secret_key';
const JWT_EXPIRY = '7d';

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user
    const result = await db.query(`
      SELECT u.*, h.name as hotel_name, h.city, h.id as hotel_id
      FROM users u
      LEFT JOIN hotels h ON u.hotel_id = h.id
      WHERE u.username = $1 AND u.is_active = true
    `, [username.toLowerCase().trim()]);

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Generate token
    const token = jwt.sign({
      userId: user.id,
      hotelId: user.hotel_id,
      role: user.role,
      username: user.username,
    }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

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
      }
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/register-hotel (super admin only) ──────────
router.post('/register-hotel', async (req, res) => {
  try {
    const {
      hotelName, city, state, phone, email, gstin,
      adminUsername, adminPassword, adminName,
      totalRooms, bufferRooms, whatsappBot, adminPhone
    } = req.body;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Create hotel
      const hotelRes = await client.query(`
        INSERT INTO hotels (name, city, state, phone, email, gstin,
          total_rooms, buffer_rooms, whatsapp_bot_number, admin_phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [hotelName, city, state, phone, email, gstin,
          totalRooms || 0, bufferRooms || 4, whatsappBot, adminPhone]);

      const hotel = hotelRes.rows[0];

      // Hash password
      const hash = await bcrypt.hash(adminPassword, 12);

      // Create admin user for hotel
      const userRes = await client.query(`
        INSERT INTO users (hotel_id, username, password_hash, name, role, email)
        VALUES ($1,$2,$3,$4,'hotel_admin',$5)
        RETURNING id, username, name, role
      `, [hotel.id, adminUsername.toLowerCase(), hash, adminName, email]);

      // Create default room types
      const roomTypes = ['Deluxe', 'Super Deluxe', 'Honeymoon'];
      for (const rt of roomTypes) {
        await client.query(`
          INSERT INTO room_types (hotel_id, name, capacity)
          VALUES ($1,$2,2)
        `, [hotel.id, rt]);
      }

      await client.query('COMMIT');

      console.log(`✓ Hotel registered: ${hotelName} | User: ${adminUsername}`);

      res.status(201).json({
        success: true,
        message: `Hotel "${hotelName}" registered successfully`,
        hotel: { id: hotel.id, name: hotel.name, city: hotel.city },
        user: userRes.rows[0],
        credentials: { username: adminUsername, password: '(as set)' }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('Register hotel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/add-user (hotel admin only) ─────────────────
router.post('/add-user', async (req, res) => {
  try {
    const { hotelId, username, password, name, role, email } = req.body;
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(`
      INSERT INTO users (hotel_id, username, password_hash, name, role, email)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, username, name, role
    `, [hotelId, username.toLowerCase(), hash, name, role || 'hotel_staff', email]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', async (req, res) => {
  try {
    const { userId, oldPassword, newPassword } = req.body;
    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(oldPassword, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.query(`
      SELECT u.id, u.username, u.name, u.role, u.email,
             h.id as hotel_id, h.name as hotel_name, h.city, h.total_rooms, h.gstin
      FROM users u LEFT JOIN hotels h ON u.hotel_id = h.id
      WHERE u.id = $1 AND u.is_active = true
    `, [decoded.userId]);
    if (!user.rows[0]) return res.status(401).json({ error: 'User not found' });
    res.json({ success: true, data: user.rows[0] });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;

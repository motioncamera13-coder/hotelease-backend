const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ── Static dashboard ──────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/dashboard', (req, res) => res.redirect('/dashboard/login.html'));

// ── PostgreSQL Pool ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Create Tables ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotels (
      id            SERIAL PRIMARY KEY,
      hotel_id      VARCHAR(30) UNIQUE NOT NULL,
      name          VARCHAR(200) NOT NULL,
      city          VARCHAR(100),
      state         VARCHAR(100),
      phone         VARCHAR(20),
      email         VARCHAR(100),
      gstin         VARCHAR(20),
      total_rooms   INTEGER DEFAULT 50,
      buffer_rooms  INTEGER DEFAULT 4,
      whatsapp_bot  VARCHAR(20),
      active        BOOLEAN DEFAULT true,
      created_at    TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(200) NOT NULL,
      name        VARCHAR(200),
      role        VARCHAR(20) DEFAULT 'hotel_admin',
      hotel_id    VARCHAR(30),
      is_active   BOOLEAN DEFAULT true,
      last_login  TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id            SERIAL PRIMARY KEY,
      booking_id    VARCHAR(30) UNIQUE NOT NULL,
      hotel_id      VARCHAR(30) NOT NULL,
      guest_name    VARCHAR(200),
      agent         VARCHAR(200),
      room_type_id  VARCHAR(100),
      rooms         INTEGER DEFAULT 1,
      check_in      DATE,
      check_out     DATE,
      nights        INTEGER,
      meal_plan     VARCHAR(10),
      rate          NUMERIC(10,2),
      total         NUMERIC(10,2),
      advance       NUMERIC(10,2) DEFAULT 0,
      status        VARCHAR(30) DEFAULT 'confirmed',
      created_at    TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id          SERIAL PRIMARY KEY,
      hotel_id    VARCHAR(30) NOT NULL,
      name        VARCHAR(200),
      phone       VARCHAR(20),
      email       VARCHAR(100),
      id_type     VARCHAR(30),
      id_number   VARCHAR(50),
      visits      INTEGER DEFAULT 1,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id          SERIAL PRIMARY KEY,
      hotel_id    VARCHAR(30) NOT NULL,
      name        VARCHAR(200) NOT NULL,
      phone       VARCHAR(20),
      company     VARCHAR(200),
      category    VARCHAR(5) DEFAULT 'C',
      commission  NUMERIC(5,2) DEFAULT 0,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          SERIAL PRIMARY KEY,
      hotel_id    VARCHAR(30) NOT NULL,
      room_number VARCHAR(10) NOT NULL,
      floor       INTEGER,
      room_type_id VARCHAR(100),
      status      VARCHAR(20) DEFAULT 'available',
      hk_status   VARCHAR(20) DEFAULT 'clean'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashbook (
      id          SERIAL PRIMARY KEY,
      hotel_id    VARCHAR(30) NOT NULL,
      date        DATE DEFAULT CURRENT_DATE,
      description VARCHAR(300),
      booking_id  VARCHAR(30),
      cash_in     NUMERIC(10,2) DEFAULT 0,
      cash_out    NUMERIC(10,2) DEFAULT 0,
      balance     NUMERIC(10,2) DEFAULT 0,
      created_by  VARCHAR(100),
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ Tables ready');

  const existing = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [process.env.SUPER_ADMIN_USERNAME]
  );
  if (existing.rows.length === 0) {
    const hashed = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, name, role, hotel_id) VALUES ($1,$2,$3,$4,$5)',
      [process.env.SUPER_ADMIN_USERNAME, hashed, 'Super Admin', 'super_admin', null]
    );
    console.log('✅ Super admin created');
  }
}

initDB().catch(console.error);

// ── Middleware ──────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function superAdminOnly(req, res, next) {
  if (req.user?.role !== 'super_admin')
    return res.status(403).json({ error: 'Super admin only' });
  next();
}

// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  try {
    const { hotelId, username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    if (user.role !== 'super_admin' && user.hotel_id !== hotelId)
      return res.status(401).json({ success: false, error: 'Invalid Hotel ID' });

    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, hotelId: user.hotel_id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ success: true, token, user: { username: user.username, name: user.name, role: user.role, hotelId: user.hotel_id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/register-hotel', auth, superAdminOnly, async (req, res) => {
  try {
    const { hotelId, name, city, state, phone, email, gstin,
            totalRooms, bufferRooms, whatsappBotNumber, adminName, username, password } = req.body;

    const userExists = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (userExists.rows.length > 0)
      return res.status(400).json({ success: false, error: 'Username already taken' });

    // Insert hotel — id is auto-generated UUID
    const hotelResult = await pool.query(
      `INSERT INTO hotels (name,city,state,phone,email,gstin,total_rooms,buffer_rooms,whatsapp_bot_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [name, city, state, phone, email, gstin, totalRooms, bufferRooms, whatsappBotNumber]
    );
    const newHotelId = hotelResult.rows[0].id;

    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username,password_hash,name,role,hotel_id) VALUES ($1,$2,$3,$4,$5)',
      [username, hashed, adminName, 'hotel_admin', newHotelId]
    );

    res.json({ success: true, hotelId: newHotelId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = result.rows[0];
    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) return res.status(400).json({ success: false, error: 'Old password incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashed, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/create-user', auth, async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username,password_hash,name,role,hotel_id) VALUES ($1,$2,$3,$4,$5)',
      [username, hashed, name, role, req.user.hotelId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/users', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, name, role, is_active, last_login, created_at FROM users WHERE hotel_id=$1',
      [req.user.hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/auth/users/:id', auth, async (req, res) => {
  try {
    const { is_active, name, role } = req.body;
    if (is_active !== undefined) {
      await pool.query('UPDATE users SET is_active=$1 WHERE id=$2 AND hotel_id=$3', [is_active, req.params.id, req.user.hotelId]);
    } else {
      await pool.query('UPDATE users SET name=$1, role=$2 WHERE id=$3 AND hotel_id=$4', [name, role, req.params.id, req.user.hotelId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/auth/users/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1 AND hotel_id=$2', [req.params.id, req.user.hotelId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/roles', auth, async (req, res) => {
  res.json({ success: true, data: ['general_manager','hotel_admin','hotel_owner','staff','housekeeping'] });
});

app.get('/api/auth/permissions', auth, async (req, res) => {
  res.json({ success: true, data: { pages: ['dashboard','reservations','rooms','checkin','guests','agents','rates','reports','billing','cashbook'] } });
});

app.post('/api/auth/permissions', auth, async (req, res) => {
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
//  HOTEL ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/api/hotels/lookup', async (req, res) => {
  const result = await pool.query('SELECT name, city FROM hotels WHERE id::text=$1', [req.query.hotelId]);
  if (result.rows.length === 0) return res.json({ found: false });
  res.json({ found: true, ...result.rows[0] });
});

app.get('/api/hotels/next-seq', auth, superAdminOnly, async (req, res) => {
  const { cityCode } = req.query;
  const year = new Date().getFullYear();
  const result = await pool.query(
    "SELECT COUNT(*) FROM hotels WHERE id::text LIKE $1",
    [`HE-${cityCode}-${year}-%`]
  );
  res.json({ seq: parseInt(result.rows[0].count) + 1 });
});

app.get('/api/hotels', auth, superAdminOnly, async (req, res) => {
  const result = await pool.query('SELECT *, id::text as hotel_id FROM hotels ORDER BY created_at DESC');
  res.json({ success: true, hotels: result.rows });
});

app.delete('/api/hotels/:hotelId', auth, superAdminOnly, async (req, res) => {
  try {
    const { hotelId } = req.params;
    await pool.query('DELETE FROM reservations WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM guests WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM agents WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM rooms WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM cashbook WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM users WHERE hotel_id::text=$1', [hotelId]);
    await pool.query('DELETE FROM hotels WHERE id::text=$1', [hotelId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════════

app.get('/api/reports/daily', auth, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const [totalRoomsRes, bookedRooms, checkins, checkouts, revenue, newBookings] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM rooms WHERE hotel_id=$1", [hotelId]),
      pool.query("SELECT COALESCE(SUM(rooms_count),0) as cnt FROM reservations WHERE hotel_id=$1 AND status IN ('confirmed','checked_in') AND checkin_date <= CURRENT_DATE AND checkout_date > CURRENT_DATE", [hotelId]),
      pool.query("SELECT COUNT(*) FROM reservations WHERE hotel_id=$1 AND checkin_date=$2 AND status='confirmed'", [hotelId, date]),
      pool.query("SELECT COUNT(*) FROM reservations WHERE hotel_id=$1 AND checkout_date=$2 AND status='checked_in'", [hotelId, date]),
      pool.query("SELECT COALESCE(SUM(cash_in),0) as total FROM cashbook WHERE hotel_id=$1 AND date=$2", [hotelId, date]),
      pool.query("SELECT COUNT(*) FROM reservations WHERE hotel_id=$1 AND DATE(created_at)=$2", [hotelId, date]),
    ]);

    const totalRooms = parseInt(totalRoomsRes.rows[0].count) || 50;
    const occupiedRooms = Math.min(parseInt(bookedRooms.rows[0].cnt), totalRooms);
    const availableRooms = Math.max(totalRooms - occupiedRooms, 0);
    const occupancyPct = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    res.json({
      success: true,
      data: {
        occupancy: { totalRooms, occupiedRooms, availableRooms, occupancyPct, percentage: occupancyPct },
        revenue: { total: parseFloat(revenue.rows[0].total) },
        checkinsToday: parseInt(checkins.rows[0].count),
        checkoutsToday: parseInt(checkouts.rows[0].count),
        newBookings: parseInt(newBookings.rows[0].count),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ROOMS
// ══════════════════════════════════════════════════════════════

app.get('/api/rooms/types', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM room_types WHERE hotel_id=$1 ORDER BY name', [req.user.hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/rooms', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, rt.name as room_type_name
      FROM rooms r
      LEFT JOIN room_types rt ON r.room_type_id::text = rt.id::text
      WHERE r.hotel_id=$1
      ORDER BY r.floor, r.room_number
    `, [req.user.hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rooms', auth, async (req, res) => {
  try {
    const { roomNumber, floor, roomTypeId } = req.body;
    await pool.query(
      'INSERT INTO rooms (hotel_id,room_number,floor,room_type_id) VALUES ($1,$2,$3,$4)',
      [req.user.hotelId, roomNumber, floor, roomTypeId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/rooms/:roomNumber', auth, async (req, res) => {
  try {
    const { status, hkStatus } = req.body;
    await pool.query(
      'UPDATE rooms SET status=$1, hk_status=$2 WHERE room_number=$3 AND hotel_id=$4',
      [status, hkStatus || 'clean', req.params.roomNumber, req.user.hotelId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  RESERVATIONS
// ══════════════════════════════════════════════════════════════

app.get('/api/reservations/checkins/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(`
      SELECT r.*, rt.name as room_type_name, g.phone as guest_phone
      FROM reservations r
      LEFT JOIN room_types rt ON r.room_type_id::text = rt.id::text
      LEFT JOIN guests g ON g.hotel_id = r.hotel_id AND g.name = r.guest_name
      WHERE r.hotel_id=$1 AND r.check_in=$2 AND r.status='confirmed'
      ORDER BY r.created_at DESC
    `, [req.user.hotelId, today]);
    const rows = result.rows.map(r => ({
      ...r, reservation_no: r.reservation_no||r.booking_id, guest_name: r.guest_name,
      room_type_name: r.room_type_name, rooms_count: r.rooms_count||r.rooms,
      checkin_date: r.checkin_date||r.check_in, checkout_date: r.checkout_date||r.check_out,
      rate_per_night: r.rate_per_night||r.rate, plan: r.plan||r.meal_plan,
      phone: r.guest_phone,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reservations/checkouts/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(`
      SELECT r.*, rt.name as room_type_name, g.phone as guest_phone
      FROM reservations r
      LEFT JOIN room_types rt ON r.room_type_id::text = rt.id::text
      LEFT JOIN guests g ON g.hotel_id = r.hotel_id AND g.name = r.guest_name
      WHERE r.hotel_id=$1 AND r.check_out=$2 AND r.status='checked_in'
      ORDER BY r.created_at DESC
    `, [req.user.hotelId, today]);
    const rows = result.rows.map(r => ({
      ...r, reservation_no: r.reservation_no||r.booking_id, guest_name: r.guest_name,
      room_type_name: r.room_type_name, rooms_count: r.rooms_count||r.rooms,
      checkin_date: r.checkin_date||r.check_in, checkout_date: r.checkout_date||r.check_out,
      rate_per_night: r.rate_per_night||r.rate, total_amount: r.total, plan: r.plan||r.meal_plan,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reservations', auth, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { status, startDate, endDate } = req.query;
    let query = `
      SELECT r.*, rt.name as room_type_name, g.phone as guest_phone
      FROM reservations r
      LEFT JOIN room_types rt ON r.room_type_id::text = rt.id::text
      LEFT JOIN guests g ON g.hotel_id = r.hotel_id AND g.name = r.guest_name
      WHERE r.hotel_id=$1
    `;
    const params = [hotelId];
    if (status) { params.push(status); query += ` AND r.status=$${params.length}`; }
    if (startDate) { params.push(startDate); query += ` AND r.check_in>=$${params.length}`; }
    if (endDate) { params.push(endDate); query += ` AND r.check_out<=$${params.length}`; }
    query += ' ORDER BY r.created_at DESC';
    const result = await pool.query(query, params);
    const rows = result.rows.map(r => ({
      ...r, reservation_no: r.reservation_no||r.booking_id, agent_name: r.agent,
      room_type_name: r.room_type_name, rooms_count: r.rooms_count||r.rooms,
      checkin_date: r.checkin_date||r.check_in, checkout_date: r.checkout_date||r.check_out,
      rate_per_night: r.rate_per_night||r.rate, total_amount: r.total, plan: r.plan||r.meal_plan,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/reservations', auth, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { guestName, agent, roomTypeId, rooms, checkIn, checkOut,
            mealPlan, rate, total, advance, phone, idType, idNumber } = req.body;
    const bookingId = 'HE' + Date.now().toString().slice(-8);

    await pool.query(
      `INSERT INTO reservations 
        (reservation_no, booking_id, hotel_id, guest_name, agent, room_type_id,
         rooms_count, rooms, checkin_date, checkout_date, check_in, check_out,
         plan, meal_plan, rate_per_night, rate, total, advance, status)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$6,$7,$8,$7,$8,$9,$9,$10,$10,$11,$12,'confirmed')`,
      [bookingId, hotelId, guestName, agent||null, roomTypeId||null,
       rooms||1, checkIn, checkOut,
       mealPlan, rate, total||0, advance||0]
    );

    if (phone) {
      await pool.query(
        `INSERT INTO guests (hotel_id, name, phone, id_type, id_number, visits)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (hotel_id, phone) DO UPDATE SET visits = guests.visits + 1, name = EXCLUDED.name`,
        [hotelId, guestName, phone, idType||null, idNumber||null]
      ).catch(async () => {
        // If no unique constraint on phone, just insert
        await pool.query(
          'INSERT INTO guests (hotel_id, name, phone, id_type, id_number, visits) VALUES ($1,$2,$3,$4,$5,1)',
          [hotelId, guestName, phone, idType||null, idNumber||null]
        ).catch(() => {});
      });
    }

    res.json({ success: true, bookingId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/reservations/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(
      'UPDATE reservations SET status=$1 WHERE (id::text=$2 OR booking_id=$2) AND hotel_id=$3',
      [status, req.params.id, req.user.hotelId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/reservations/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM reservations WHERE (id::text=$1 OR booking_id=$1) AND hotel_id=$2',
      [req.params.id, req.user.hotelId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GUESTS
// ══════════════════════════════════════════════════════════════

app.get('/api/guests', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM guests WHERE hotel_id=$1 ORDER BY created_at DESC',
      [req.user.hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AGENTS
// ══════════════════════════════════════════════════════════════

app.get('/api/agents', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM agents WHERE hotel_id=$1 ORDER BY name',
      [req.user.hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/agents', auth, async (req, res) => {
  try {
    const { name, phone, company, category, commission } = req.body;
    await pool.query(
      'INSERT INTO agents (hotel_id,name,phone,company,category,commission) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.hotelId, name, phone, company, category||'C', commission||0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  CASHBOOK
// ══════════════════════════════════════════════════════════════

app.get('/api/cashbook', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      'SELECT * FROM cashbook WHERE hotel_id=$1 AND date=$2 ORDER BY created_at',
      [req.user.hotelId, date]
    );
    const cashIn = result.rows.reduce((s,r) => s + parseFloat(r.cash_in||0), 0);
    const cashOut = result.rows.reduce((s,r) => s + parseFloat(r.cash_out||0), 0);
    res.json({ success: true, data: result.rows, summary: { cashIn, cashOut, balance: cashIn - cashOut, openingBalance: 0 } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/cashbook/daily-summary', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      'SELECT COALESCE(SUM(cash_in),0) as cash_in, COALESCE(SUM(cash_out),0) as cash_out FROM cashbook WHERE hotel_id=$1 AND date=$2',
      [req.user.hotelId, date]
    );
    const r = result.rows[0];
    res.json({ success: true, data: { cashIn: parseFloat(r.cash_in), cashOut: parseFloat(r.cash_out), balance: parseFloat(r.cash_in) - parseFloat(r.cash_out) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cashbook', auth, async (req, res) => {
  try {
    const { description, bookingId, cashIn, cashOut, balance } = req.body;
    await pool.query(
      'INSERT INTO cashbook (hotel_id,description,booking_id,cash_in,cash_out,balance,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.hotelId, description, bookingId, cashIn||0, cashOut||0, balance||0, req.user.username]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════

app.get('/api/reports/monthly', auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    const result = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as bookings, COALESCE(SUM(total),0) as revenue
      FROM reservations WHERE hotel_id=$1 AND EXTRACT(YEAR FROM created_at)=$2 AND EXTRACT(MONTH FROM created_at)=$3
      GROUP BY DATE(created_at) ORDER BY date
    `, [req.user.hotelId, year, month]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/agents', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT agent, COUNT(*) as bookings, COALESCE(SUM(total),0) as revenue
      FROM reservations WHERE hotel_id=$1 GROUP BY agent ORDER BY revenue DESC
    `, [req.user.hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  HOUSEKEEPING
// ══════════════════════════════════════════════════════════════

app.get('/api/housekeeping', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, rt.name as room_type_name
      FROM rooms r LEFT JOIN room_types rt ON r.room_type_id::text = rt.id::text
      WHERE r.hotel_id=$1 ORDER BY r.floor, r.room_number
    `, [req.user.hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/housekeeping/:roomId', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(
      'UPDATE rooms SET status=$1 WHERE room_number=$2 AND hotel_id=$3',
      [status, req.params.roomId, req.user.hotelId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  OPERATIONS
// ══════════════════════════════════════════════════════════════

app.get('/api/operations/swaps', auth, async (req, res) => {
  res.json({ success: true, data: [] });
});

app.post('/api/operations/swap', auth, async (req, res) => {
  try {
    const { fromRoom, toRoom } = req.body;
    await pool.query("UPDATE rooms SET status='available' WHERE room_number=$1 AND hotel_id=$2", [fromRoom, req.user.hotelId]);
    await pool.query("UPDATE rooms SET status='occupied' WHERE room_number=$1 AND hotel_id=$2", [toRoom, req.user.hotelId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Rates ───────────────────────────────────────────────────────
app.get('/api/rates', auth, async (req, res) => {
  try {
    // Get rates from room_rates table if it exists, otherwise from room_types
    const ratesResult = await pool.query(`
      SELECT rt.name as room_type_name, rt.id as room_type_id,
             COALESCE(r.ep_rate, rt.base_rate, 0) as ep_rate,
             COALESCE(r.cp_rate, rt.base_rate, 0) as cp_rate,
             COALESCE(r.map_rate, rt.base_rate, 0) as map_rate
      FROM room_types rt
      LEFT JOIN room_rates r ON r.room_type_id = rt.id
      WHERE rt.hotel_id=$1
      ORDER BY rt.name
    `, [req.user.hotelId]).catch(() => ({ rows: [] }));

    if (ratesResult.rows.length) {
      // Expand into one row per plan
      const rows = [];
      ratesResult.rows.forEach(r => {
        rows.push({ room_type_name: r.room_type_name, room_type_id: r.room_type_id, plan: 'EP', rate: parseFloat(r.ep_rate||0) });
        rows.push({ room_type_name: r.room_type_name, room_type_id: r.room_type_id, plan: 'CP', rate: parseFloat(r.cp_rate||0) });
        rows.push({ room_type_name: r.room_type_name, room_type_id: r.room_type_id, plan: 'MAP', rate: parseFloat(r.map_rate||0) });
      });
      return res.json({ success: true, data: rows });
    }

    // Fallback: return room types with 0 rates
    const types = await pool.query('SELECT * FROM room_types WHERE hotel_id=$1', [req.user.hotelId]);
    const rows = [];
    types.rows.forEach(rt => {
      ['EP','CP','MAP'].forEach(plan => {
        rows.push({ room_type_name: rt.name, room_type_id: rt.id, plan, rate: 0 });
      });
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rates', auth, async (req, res) => {
  try {
    const { roomTypeId, plan, rate } = req.body;
    await pool.query(`
      INSERT INTO room_rates (hotel_id, room_type_id, plan, rate_per_night)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (hotel_id, room_type_id, plan) DO UPDATE SET rate_per_night=$4
    `, [req.user.hotelId, roomTypeId, plan, rate]).catch(async () => {
      // If room_rates table doesn't exist, create it
      await pool.query(`CREATE TABLE IF NOT EXISTS room_rates (
        id SERIAL PRIMARY KEY,
        hotel_id VARCHAR(100),
        room_type_id UUID,
        plan VARCHAR(10),
        rate_per_night NUMERIC(10,2),
        UNIQUE(hotel_id, room_type_id, plan)
      )`);
      await pool.query(
        'INSERT INTO room_rates (hotel_id,room_type_id,plan,rate_per_night) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [req.user.hotelId, roomTypeId, plan, rate]
      );
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  WHATSAPP PROXY — calls bot server internally (no CORS issues)
// ══════════════════════════════════════════════════════════════
const https = require('https');

function callBot(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'hotel-whatsapp-bot-2ole.onrender.com',
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ success: true }); } });
    });
    req.on('error', reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error('Bot timeout')); });
    req.write(data);
    req.end();
  });
}

// Wake up the bot (fire and forget)
function wakeBot() {
  try {
    https.get('https://hotel-whatsapp-bot-2ole.onrender.com/', () => {});
  } catch(e) {}
}

app.post('/api/whatsapp/optin', auth, async (req, res) => {
  try {
    wakeBot();
    const result = await callBot('/send-optin', req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/checkin', auth, async (req, res) => {
  try {
    wakeBot();
    const result = await callBot('/send-checkin', req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/checkout', auth, async (req, res) => {
  try {
    wakeBot();
    const result = await callBot('/send-checkout', req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: '✅ HotelEase API running', version: '1.0' }));

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 HotelEase API on port ${PORT}`));

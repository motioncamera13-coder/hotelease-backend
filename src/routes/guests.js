const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ── GET /api/guests — search guests ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, search } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });

    let query = 'SELECT * FROM guests WHERE hotel_id = $1';
    const params = [hotelId];

    if (search) {
      query += ' AND (LOWER(name) LIKE LOWER($2) OR phone LIKE $2)';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';
    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/guests/:id ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const guest = await db.query('SELECT * FROM guests WHERE id = $1', [req.params.id]);
    if (!guest.rows[0]) return res.status(404).json({ error: 'Guest not found' });

    // Get guest booking history
    const history = await db.query(`
      SELECT r.*, rt.name as room_type_name
      FROM reservations r
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.guest_id = $1
      ORDER BY r.checkin_date DESC
    `, [req.params.id]);

    res.json({ success: true, data: { ...guest.rows[0], bookings: history.rows } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/guests — create guest ───────────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, name, phone, email, idType, idNumber, address } = req.body;
    if (!hotelId || !name) return res.status(400).json({ error: 'hotelId and name required' });

    // Check if guest already exists by phone
    if (phone) {
      const existing = await db.query(
        'SELECT * FROM guests WHERE hotel_id = $1 AND phone = $2',
        [hotelId, phone]
      );
      if (existing.rows[0]) {
        return res.json({ success: true, data: existing.rows[0], existing: true });
      }
    }

    const result = await db.query(`
      INSERT INTO guests (hotel_id, name, phone, email, id_type, id_number, address)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [hotelId, name, phone, email, idType, idNumber, address]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/guests/:id — update guest ──────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { name, phone, email, idType, idNumber, address } = req.body;
    const result = await db.query(`
      UPDATE guests SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        email = COALESCE($3, email),
        id_type = COALESCE($4, id_type),
        id_number = COALESCE($5, id_number),
        address = COALESCE($6, address)
      WHERE id = $7 RETURNING *
    `, [name, phone, email, idType, idNumber, address, req.params.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

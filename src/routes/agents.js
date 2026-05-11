const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ── GET /api/agents — get all agents ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });
    const result = await db.query(`
      SELECT a.*,
        COUNT(r.id) as total_bookings,
        COALESCE(SUM(r.rate_per_night * r.rooms_count * r.nights), 0) as total_revenue
      FROM agents a
      LEFT JOIN reservations r ON a.id = r.agent_id AND r.status != 'cancelled'
      WHERE a.hotel_id = $1
      GROUP BY a.id
      ORDER BY a.name
    `, [hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agents/:id ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*,
        COUNT(r.id) as total_bookings,
        COALESCE(SUM(r.rate_per_night * r.rooms_count * r.nights), 0) as total_revenue
      FROM agents a
      LEFT JOIN reservations r ON a.id = r.agent_id AND r.status != 'cancelled'
      WHERE a.id = $1
      GROUP BY a.id
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agents — create agent ───────────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, name, phone, email, category, company } = req.body;
    if (!hotelId || !name || !phone) {
      return res.status(400).json({ error: 'hotelId, name and phone are required' });
    }
    const discounts = { A: 10, B: 5, C: 0 };
    const discount = discounts[category?.toUpperCase()] || 0;

    const result = await db.query(`
      INSERT INTO agents (hotel_id, name, phone, email, category, discount_pct, company)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (phone) DO UPDATE SET
        name = $2, email = $4, category = $5, discount_pct = $6, company = $7
      RETURNING *
    `, [hotelId, name, phone, email, category?.toUpperCase() || 'C', discount, company]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/agents/:id — update agent ──────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { name, email, category, company, isActive } = req.body;
    const discounts = { A: 10, B: 5, C: 0 };
    const discount = category ? (discounts[category.toUpperCase()] || 0) : undefined;

    const result = await db.query(`
      UPDATE agents SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        category = COALESCE($3, category),
        discount_pct = COALESCE($4, discount_pct),
        company = COALESCE($5, company),
        is_active = COALESCE($6, is_active)
      WHERE id = $7
      RETURNING *
    `, [name, email, category?.toUpperCase(), discount, company, isActive, req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/agents/:id — deactivate agent ─────────────────
router.delete('/:id', async (req, res) => {
  try {
    await db.query('UPDATE agents SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Agent deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agents/phone/:phone — find by phone ──────────────
router.get('/phone/:phone', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM agents WHERE phone = $1 AND is_active = true',
      [req.params.phone]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agents/:id/bookings — agent booking history ──────
router.get('/:id/bookings', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT r.*, rt.name as room_type_name, g.name as guest_name
      FROM reservations r
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN guests g ON r.guest_id = g.id
      WHERE r.agent_id = $1
      ORDER BY r.created_at DESC
      LIMIT 50
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

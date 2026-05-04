const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// ── GET /api/housekeeping ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(`
      SELECT r.id as room_id, r.room_number, r.floor, rt.name as room_type,
             COALESCE(h.status, 'dirty') as hk_status,
             h.assigned_to, h.priority, h.notes, h.last_cleaned, h.updated_by,
             res.reservation_no, g.name as current_guest,
             CASE WHEN res.checkout_date = CURRENT_DATE AND res.status = 'checked_in'
               THEN true ELSE false END as checkout_today
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN housekeeping h ON r.id = h.room_id
      LEFT JOIN reservation_rooms rr ON r.id = rr.room_id
      LEFT JOIN reservations res ON rr.reservation_id = res.id
        AND res.status IN ('confirmed','checked_in')
        AND res.checkin_date <= CURRENT_DATE AND res.checkout_date > CURRENT_DATE
      LEFT JOIN guests g ON res.guest_id = g.id
      WHERE r.hotel_id = $1
      ORDER BY r.floor, r.room_number
    `, [hotelId]);

    const summary = {
      dirty: result.rows.filter(r => r.hk_status === 'dirty').length,
      cleaning: result.rows.filter(r => r.hk_status === 'cleaning').length,
      clean: result.rows.filter(r => r.hk_status === 'clean').length,
      inspected: result.rows.filter(r => r.hk_status === 'inspected').length,
      out_of_order: result.rows.filter(r => r.hk_status === 'out_of_order').length,
    };

    res.json({ success: true, data: result.rows, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/housekeeping/:roomId ───────────────────────────
router.patch('/:roomId', async (req, res) => {
  try {
    const { status, assignedTo, priority, notes, updatedBy } = req.body;
    await db.query(`
      INSERT INTO housekeeping (room_id, status, assigned_to, priority, notes, updated_by, updated_at,
        last_cleaned)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(), CASE WHEN $2 IN ('clean','inspected') THEN NOW() ELSE NULL END)
      ON CONFLICT (room_id) DO UPDATE SET
        status = COALESCE($2, housekeeping.status),
        assigned_to = COALESCE($3, housekeeping.assigned_to),
        priority = COALESCE($4, housekeeping.priority),
        notes = COALESCE($5, housekeeping.notes),
        updated_by = $6, updated_at = NOW(),
        last_cleaned = CASE WHEN $2 IN ('clean','inspected') THEN NOW() ELSE housekeeping.last_cleaned END
    `, [req.params.roomId, status, assignedTo, priority || 'normal', notes, updatedBy]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/housekeeping/assign-bulk ────────────────────────
router.post('/assign-bulk', async (req, res) => {
  try {
    const { roomIds, assignedTo } = req.body;
    for (const roomId of roomIds) {
      await db.query(`
        INSERT INTO housekeeping (room_id, assigned_to, status, updated_at)
        VALUES ($1,$2,'cleaning',NOW())
        ON CONFLICT (room_id) DO UPDATE SET assigned_to=$2, status='cleaning', updated_at=NOW()
      `, [roomId, assignedTo]);
    }
    res.json({ success: true, message: `${roomIds.length} rooms assigned` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

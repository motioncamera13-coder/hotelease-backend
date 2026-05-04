const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// ── GET /api/rooms — get all rooms with live status ───────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, date } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });

    const checkDate = date || new Date().toISOString().split('T')[0];

    const result = await db.query(`
      SELECT r.*, rt.name as room_type_name, rt.capacity,
        CASE
          WHEN r.status = 'maintenance' THEN 'maintenance'
          WHEN EXISTS (
            SELECT 1 FROM reservation_rooms rr
            JOIN reservations res ON rr.reservation_id = res.id
            WHERE rr.room_id = r.id
              AND res.status IN ('confirmed', 'checked_in')
              AND res.checkin_date <= $2
              AND res.checkout_date > $2
          ) THEN 'occupied'
          ELSE 'available'
        END as live_status,
        (
          SELECT res.reservation_no
          FROM reservation_rooms rr
          JOIN reservations res ON rr.reservation_id = res.id
          WHERE rr.room_id = r.id
            AND res.status IN ('confirmed', 'checked_in')
            AND res.checkin_date <= $2
            AND res.checkout_date > $2
          LIMIT 1
        ) as current_reservation_no,
        (
          SELECT g.name
          FROM reservation_rooms rr
          JOIN reservations res ON rr.reservation_id = res.id
          JOIN guests g ON res.guest_id = g.id
          WHERE rr.room_id = r.id
            AND res.status IN ('confirmed', 'checked_in')
            AND res.checkin_date <= $2
            AND res.checkout_date > $2
          LIMIT 1
        ) as current_guest_name
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.hotel_id = $1
      ORDER BY r.floor, r.room_number
    `, [hotelId, checkDate]);

    // Group by floor
    const byFloor = {};
    for (const room of result.rows) {
      if (!byFloor[room.floor]) byFloor[room.floor] = [];
      byFloor[room.floor].push(room);
    }

    res.json({
      success: true,
      data: result.rows,
      byFloor,
      summary: {
        total: result.rows.length,
        available: result.rows.filter(r => r.live_status === 'available').length,
        occupied: result.rows.filter(r => r.live_status === 'occupied').length,
        maintenance: result.rows.filter(r => r.live_status === 'maintenance').length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rooms/availability — availability for date range ─
router.get('/availability', async (req, res) => {
  try {
    const { hotelId, checkinDate, checkoutDate } = req.query;

    const result = await db.query(`
      SELECT rt.id, rt.name, rt.capacity,
        COUNT(r.id) as total_rooms,
        COUNT(r.id) - COUNT(DISTINCT rr.room_id) as available_rooms,
        (SELECT rate_per_night FROM rates ra
          JOIN seasons s ON ra.season_id = s.id
          WHERE ra.room_type_id = rt.id
            AND ra.hotel_id = $1
            AND $2::date BETWEEN s.start_date AND s.end_date
            AND ra.plan = 'CP'
          LIMIT 1) as cp_rate,
        (SELECT rate_per_night FROM rates ra
          JOIN seasons s ON ra.season_id = s.id
          WHERE ra.room_type_id = rt.id
            AND ra.hotel_id = $1
            AND $2::date BETWEEN s.start_date AND s.end_date
            AND ra.plan = 'MAP'
          LIMIT 1) as map_rate
      FROM room_types rt
      JOIN rooms r ON rt.id = r.room_type_id AND r.hotel_id = $1 AND r.status = 'available'
      LEFT JOIN reservation_rooms rr ON r.id = rr.room_id
      LEFT JOIN reservations res ON rr.reservation_id = res.id
        AND res.status NOT IN ('cancelled', 'checked_out')
        AND res.checkin_date < $3
        AND res.checkout_date > $2
      WHERE rt.hotel_id = $1
      GROUP BY rt.id, rt.name, rt.capacity
      ORDER BY rt.name
    `, [hotelId, checkinDate, checkoutDate]);

    const hotel = await db.query('SELECT buffer_rooms FROM hotels WHERE id = $1', [hotelId]);
    const buffer = hotel.rows[0]?.buffer_rooms || 4;

    const data = result.rows.map(rt => ({
      ...rt,
      effective_available: Math.max(0, parseInt(rt.available_rooms) - Math.floor(buffer / result.rows.length)),
    }));

    res.json({ success: true, data, bufferRooms: buffer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rooms — add a room ──────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, roomTypeId, roomNumber, floor } = req.body;
    const result = await db.query(`
      INSERT INTO rooms (hotel_id, room_type_id, room_number, floor)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [hotelId, roomTypeId, roomNumber, floor || 1]);

    // Update total rooms count
    await db.query(`
      UPDATE hotels SET total_rooms = (
        SELECT COUNT(*) FROM rooms WHERE hotel_id = $1
      ) WHERE id = $1
    `, [hotelId]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Room number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/rooms/:id/status — update room status ──────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['available', 'occupied', 'maintenance', 'housekeeping'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use: ' + validStatuses.join(', ') });
    }
    const result = await db.query(
      'UPDATE rooms SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rooms/types — get room types ─────────────────────
router.get('/types', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(
      'SELECT * FROM room_types WHERE hotel_id = $1 ORDER BY name',
      [hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rooms/types — add room type ─────────────────────
router.post('/types', async (req, res) => {
  try {
    const { hotelId, name, description, capacity } = req.body;
    const result = await db.query(`
      INSERT INTO room_types (hotel_id, name, description, capacity)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [hotelId, name, description, capacity || 2]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

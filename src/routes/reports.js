const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// ── GET /api/reports/daily — daily report ─────────────────────
router.get('/daily', async (req, res) => {
  try {
    const { hotelId, date } = req.query;
    const reportDate = date || new Date().toISOString().split('T')[0];

    // Today's check-ins
    const checkins = await db.query(`
      SELECT COUNT(*) as count,
        COALESCE(SUM(rooms_count), 0) as rooms
      FROM reservations
      WHERE hotel_id = $1 AND checkin_date = $2
        AND status NOT IN ('cancelled')
    `, [hotelId, reportDate]);

    // Today's check-outs
    const checkouts = await db.query(`
      SELECT COUNT(*) as count,
        COALESCE(SUM(rooms_count), 0) as rooms
      FROM reservations
      WHERE hotel_id = $1 AND checkout_date = $2
        AND status NOT IN ('cancelled')
    `, [hotelId, reportDate]);

    // Occupancy
    const occupancy = await db.query(`
      SELECT
        COUNT(DISTINCT r.id) as occupied_rooms,
        h.total_rooms,
        ROUND(COUNT(DISTINCT r.id)::decimal / NULLIF(h.total_rooms, 0) * 100, 1) as occupancy_pct
      FROM hotels h
      LEFT JOIN rooms r ON h.id = r.hotel_id
      LEFT JOIN reservation_rooms rr ON r.id = rr.room_id
      LEFT JOIN reservations res ON rr.reservation_id = res.id
        AND res.status IN ('confirmed', 'checked_in')
        AND res.checkin_date <= $2
        AND res.checkout_date > $2
      WHERE h.id = $1
      GROUP BY h.total_rooms
    `, [hotelId, reportDate]);

    // Revenue today (check-ins)
    const revenue = await db.query(`
      SELECT
        COALESCE(SUM(r.rate_per_night * r.rooms_count * r.nights), 0) as room_revenue,
        COALESCE((
          SELECT SUM(ec.total)
          FROM extra_charges ec
          JOIN reservations r2 ON ec.reservation_id = r2.id
          WHERE r2.hotel_id = $1
            AND r2.checkin_date = $2
            AND ec.is_free = false
        ), 0) as extra_revenue
      FROM reservations r
      WHERE r.hotel_id = $1
        AND r.checkin_date = $2
        AND r.status NOT IN ('cancelled')
    `, [hotelId, reportDate]);

    // New bookings created today
    const newBookings = await db.query(`
      SELECT COUNT(*) as count
      FROM reservations
      WHERE hotel_id = $1
        AND DATE(created_at) = $2
        AND status != 'cancelled'
    `, [hotelId, reportDate]);

    // In-house guests
    const inHouse = await db.query(`
      SELECT r.reservation_no, g.name as guest_name, g.phone as guest_phone,
             rt.name as room_type, r.rooms_count, r.checkin_date, r.checkout_date,
             r.plan, r.nights, a.name as agent_name
      FROM reservations r
      LEFT JOIN guests g ON r.guest_id = g.id
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN agents a ON r.agent_id = a.id
      WHERE r.hotel_id = $1
        AND r.checkin_date <= $2
        AND r.checkout_date > $2
        AND r.status IN ('confirmed', 'checked_in')
      ORDER BY r.checkin_date
    `, [hotelId, reportDate]);

    const roomRevenue = parseFloat(revenue.rows[0]?.room_revenue || 0);
    const extraRevenue = parseFloat(revenue.rows[0]?.extra_revenue || 0);

    res.json({
      success: true,
      data: {
        date: reportDate,
        checkins: { count: parseInt(checkins.rows[0]?.count || 0), rooms: parseInt(checkins.rows[0]?.rooms || 0) },
        checkouts: { count: parseInt(checkouts.rows[0]?.count || 0), rooms: parseInt(checkouts.rows[0]?.rooms || 0) },
        occupancy: {
          occupiedRooms: parseInt(occupancy.rows[0]?.occupied_rooms || 0),
          totalRooms: parseInt(occupancy.rows[0]?.total_rooms || 0),
          percentage: parseFloat(occupancy.rows[0]?.occupancy_pct || 0),
        },
        revenue: {
          rooms: roomRevenue,
          extras: extraRevenue,
          total: roomRevenue + extraRevenue,
        },
        newBookings: parseInt(newBookings.rows[0]?.count || 0),
        inHouse: inHouse.rows,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/monthly — monthly summary ────────────────
router.get('/monthly', async (req, res) => {
  try {
    const { hotelId, year, month } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || (new Date().getMonth() + 1);

    const result = await db.query(`
      SELECT
        DATE(checkin_date) as date,
        COUNT(*) as bookings,
        SUM(rooms_count) as rooms,
        SUM(nights) as total_nights,
        SUM(rate_per_night * rooms_count * nights) as revenue
      FROM reservations
      WHERE hotel_id = $1
        AND EXTRACT(YEAR FROM checkin_date) = $2
        AND EXTRACT(MONTH FROM checkin_date) = $3
        AND status != 'cancelled'
      GROUP BY DATE(checkin_date)
      ORDER BY date
    `, [hotelId, y, m]);

    const totals = result.rows.reduce((acc, row) => ({
      bookings: acc.bookings + parseInt(row.bookings),
      rooms: acc.rooms + parseInt(row.rooms),
      revenue: acc.revenue + parseFloat(row.revenue),
    }), { bookings: 0, rooms: 0, revenue: 0 });

    res.json({ success: true, data: { daily: result.rows, totals, year: y, month: m } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/agents — agent performance ───────────────
router.get('/agents', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;
    const start = startDate || new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0]; // April 1
    const end = endDate || new Date().toISOString().split('T')[0];

    const result = await db.query(`
      SELECT
        a.id, a.name, a.phone, a.category, a.company,
        COUNT(r.id) as total_bookings,
        COALESCE(SUM(r.rooms_count), 0) as total_rooms,
        COALESCE(SUM(r.nights), 0) as total_nights,
        COALESCE(SUM(r.rate_per_night * r.rooms_count * r.nights), 0) as total_revenue,
        COUNT(CASE WHEN r.status = 'cancelled' THEN 1 END) as cancelled_bookings
      FROM agents a
      LEFT JOIN reservations r ON a.id = r.agent_id
        AND r.checkin_date BETWEEN $2 AND $3
      WHERE a.hotel_id = $1 AND a.is_active = true
      GROUP BY a.id, a.name, a.phone, a.category, a.company
      ORDER BY total_revenue DESC
    `, [hotelId, start, end]);

    res.json({ success: true, data: result.rows, period: { start, end } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/occupancy — occupancy calendar ──────────
router.get('/occupancy', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;

    const result = await db.query(`
      SELECT
        d::date as date,
        COUNT(DISTINCT rr.room_id) as occupied_rooms,
        h.total_rooms,
        ROUND(COUNT(DISTINCT rr.room_id)::decimal / NULLIF(h.total_rooms, 0) * 100, 1) as occupancy_pct
      FROM generate_series($2::date, $3::date, '1 day'::interval) d
      CROSS JOIN hotels h
      LEFT JOIN rooms r ON h.id = r.hotel_id
      LEFT JOIN reservation_rooms rr ON r.id = rr.room_id
      LEFT JOIN reservations res ON rr.reservation_id = res.id
        AND res.status NOT IN ('cancelled')
        AND res.checkin_date <= d::date
        AND res.checkout_date > d::date
      WHERE h.id = $1
      GROUP BY d, h.total_rooms
      ORDER BY d
    `, [hotelId, startDate, endDate]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/revenue — revenue breakdown ──────────────
router.get('/revenue', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;

    const byRoomType = await db.query(`
      SELECT rt.name as room_type,
        COUNT(r.id) as bookings,
        SUM(r.rooms_count) as rooms,
        SUM(r.rate_per_night * r.rooms_count * r.nights) as revenue
      FROM reservations r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.hotel_id = $1
        AND r.checkin_date BETWEEN $2 AND $3
        AND r.status != 'cancelled'
      GROUP BY rt.name
      ORDER BY revenue DESC
    `, [hotelId, startDate, endDate]);

    const byPlan = await db.query(`
      SELECT plan,
        COUNT(*) as bookings,
        SUM(rate_per_night * rooms_count * nights) as revenue
      FROM reservations
      WHERE hotel_id = $1
        AND checkin_date BETWEEN $2 AND $3
        AND status != 'cancelled'
      GROUP BY plan
    `, [hotelId, startDate, endDate]);

    const extras = await db.query(`
      SELECT charge_type,
        COUNT(*) as count,
        SUM(total) as revenue
      FROM extra_charges ec
      JOIN reservations r ON ec.reservation_id = r.id
      WHERE r.hotel_id = $1
        AND r.checkin_date BETWEEN $2 AND $3
        AND ec.is_free = false
      GROUP BY charge_type
    `, [hotelId, startDate, endDate]);

    res.json({
      success: true,
      data: {
        byRoomType: byRoomType.rows,
        byPlan: byPlan.rows,
        extras: extras.rows,
      },
      period: { startDate, endDate }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

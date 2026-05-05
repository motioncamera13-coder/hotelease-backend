const express = require('express');
const router = express.Router();
const Reservation = require('../models/reservation');
const RatesModel = require('../models/rates');
const db = require('../../config/database');

// ── GET /api/reservations — get all reservations ──────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });
    const reservations = await Reservation.getAllReservations(hotelId, req.query);
    res.json({ success: true, data: reservations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reservations/:id — get single reservation ────────
router.get('/:id', async (req, res) => {
  try {
    const reservation = await Reservation.getReservation(req.params.id);
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    res.json({ success: true, data: reservation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reservations — create new reservation ───────────
router.post('/', async (req, res) => {
  try {
    const {
      hotelId, agentPhone, guestName, guestPhone,
      roomTypeName, checkinDate, checkoutDate,
      roomsCount, plan, source
    } = req.body;

    // Find agent
    const agentRes = await db.query(
      'SELECT * FROM agents WHERE phone = $1 AND hotel_id = $2 AND is_active = true',
      [agentPhone, hotelId]
    );
    if (!agentRes.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    const agent = agentRes.rows[0];

    // Find room type
    const rtRes = await db.query(
      'SELECT * FROM room_types WHERE hotel_id = $1 AND LOWER(name) LIKE LOWER($2)',
      [hotelId, `%${roomTypeName}%`]
    );
    if (!rtRes.rows[0]) return res.status(404).json({ error: 'Room type not found' });
    const roomType = rtRes.rows[0];

    // Check availability
    const availability = await Reservation.checkAvailability(
      hotelId, roomType.id, checkinDate, checkoutDate, roomsCount
    );
    if (!availability.available) {
      return res.status(409).json({ error: 'Rooms not available', availability });
    }

    // Get rate with agent category discount
    const rateInfo = await RatesModel.getRateForAgent(
      hotelId, roomType.id, checkinDate, plan, agent.category
    );
    if (!rateInfo) return res.status(404).json({ error: 'Rate not found for this combination' });

    // Create or find guest
    let guestId = null;
    if (guestName || guestPhone) {
      const existingGuest = guestPhone
        ? await db.query('SELECT id FROM guests WHERE phone = $1 AND hotel_id = $2', [guestPhone, hotelId])
        : { rows: [] };

      if (existingGuest.rows[0]) {
        guestId = existingGuest.rows[0].id;
      } else if (guestName) {
        const newGuest = await db.query(
          'INSERT INTO guests (hotel_id, name, phone) VALUES ($1,$2,$3) RETURNING id',
          [hotelId, guestName, guestPhone]
        );
        guestId = newGuest.rows[0].id;
      }
    }

    // Create reservation
    const reservation = await Reservation.createReservation({
      hotelId,
      agentId: agent.id,
      guestId,
      roomTypeId: roomType.id,
      seasonId: rateInfo.seasonId,
      checkinDate,
      checkoutDate,
      roomsCount: parseInt(roomsCount),
      plan: plan.toUpperCase(),
      ratePerNight: rateInfo.finalRate,
      source: source || 'whatsapp',
    });

    res.status(201).json({
      success: true,
      data: {
        ...reservation,
        roomTypeName: roomType.name,
        agentName: agent.name,
        rate: rateInfo.finalRate,
        season: rateInfo.season,
        discount: rateInfo.discount,
      }
    });

  } catch (err) {
    console.error('Create reservation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/reservations/:id/status — update status ────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['confirmed', 'checked_in', 'checked_out', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const reservation = await Reservation.updateStatus(req.params.id, status);
    res.json({ success: true, data: reservation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reservations/:id/extras — add extra charge ──────
router.post('/:id/extras', async (req, res) => {
  try {
    const { chargeType, description, quantity, nights, rate, isFree, personAge, addedBy } = req.body;
    const extra = await Reservation.addExtraCharge({
      reservationId: req.params.id,
      chargeType, description, quantity, nights, rate,
      isFree: isFree || false, personAge, addedBy
    });
    res.status(201).json({ success: true, data: extra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reservations/:id/bill — generate bill ────────────
router.get('/:id/bill', async (req, res) => {
  try {
    const bill = await Reservation.generateBill(req.params.id);
    res.json({ success: true, data: bill });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reservations/checkins/today ──────────────────────
router.get('/checkins/today', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const checkins = await Reservation.getTodayCheckins(hotelId);
    res.json({ success: true, data: checkins, count: checkins.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reservations/checkouts/today ─────────────────────
router.get('/checkouts/today', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const checkouts = await Reservation.getTodayCheckouts(hotelId);
    res.json({ success: true, data: checkouts, count: checkouts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reservations/availability/check ──────────────────
router.get('/availability/check', async (req, res) => {
  try {
    const { hotelId, roomTypeId, checkinDate, checkoutDate, roomsNeeded } = req.query;
    const result = await Reservation.checkAvailability(
      hotelId, roomTypeId, checkinDate, checkoutDate, parseInt(roomsNeeded)
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ── POST /api/reservations/:id/assign-room ────────────────────
router.post('/:id/assign-room', async (req, res) => {
  try {
    const { roomId } = req.body;

    // Check if room already assigned
    const existing = await db.query(
      'SELECT * FROM reservation_rooms WHERE reservation_id=$1',
      [req.params.id]
    );

    if (existing.rows.length > 0) {
      // Update existing assignment
      await db.query(
        'UPDATE reservation_rooms SET room_id=$1 WHERE reservation_id=$2',
        [roomId, req.params.id]
      );
    } else {
      // New assignment
      await db.query(
        'INSERT INTO reservation_rooms (reservation_id, room_id) VALUES ($1,$2)',
        [req.params.id, roomId]
      );
    }

    res.json({ success: true, message: 'Room assigned successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

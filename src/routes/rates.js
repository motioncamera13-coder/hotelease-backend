const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const RatesModel = require('../models/rates');

// ── GET /api/rates — get all rates ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });
    const rates = await RatesModel.getAllRates(hotelId);
    res.json({ success: true, data: rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rates/agent — rate for specific agent and dates ──
router.get('/agent', async (req, res) => {
  try {
    const { hotelId, roomTypeId, checkinDate, plan, agentCategory } = req.query;
    const rate = await RatesModel.getRateForAgent(hotelId, roomTypeId, checkinDate, plan, agentCategory || 'C');
    if (!rate) return res.status(404).json({ error: 'Rate not found' });
    res.json({ success: true, data: rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rates — add or update rate ──────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, roomTypeId, seasonId, plan, ratePerNight, extraBedCharge, extraBreakfastCharge } = req.body;
    const result = await db.query(`
      INSERT INTO rates (hotel_id, room_type_id, season_id, plan, rate_per_night, extra_bed_charge, extra_breakfast_charge)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (room_type_id, season_id, plan) DO UPDATE SET
        rate_per_night = $5,
        extra_bed_charge = COALESCE($6, rates.extra_bed_charge),
        extra_breakfast_charge = COALESCE($7, rates.extra_breakfast_charge)
      RETURNING *
    `, [hotelId, roomTypeId, seasonId, plan, ratePerNight, extraBedCharge, extraBreakfastCharge]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rates/seasons — get all seasons ──────────────────
router.get('/seasons', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(
      'SELECT * FROM seasons WHERE hotel_id = $1 ORDER BY start_date',
      [hotelId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rates/seasons — add season ──────────────────────
router.post('/seasons', async (req, res) => {
  try {
    const { hotelId, name, startDate, endDate } = req.body;
    const result = await db.query(`
      INSERT INTO seasons (hotel_id, name, start_date, end_date)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [hotelId, name, startDate, endDate]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rates/seed — seed default rates ─────────────────
router.post('/seed', async (req, res) => {
  try {
    const { hotelId } = req.body;
    await RatesModel.seedDefaultRates(hotelId);
    res.json({ success: true, message: 'Default rates seeded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

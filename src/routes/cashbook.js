const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ── GET /api/cashbook — get entries ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, date, startDate, endDate } = req.query;
    let where = 'WHERE hotel_id = $1';
    const params = [hotelId];
    let i = 2;

    if (date) { where += ` AND date = $${i++}`; params.push(date); }
    else if (startDate && endDate) {
      where += ` AND date BETWEEN $${i++} AND $${i++}`;
      params.push(startDate, endDate);
    }

    const result = await db.query(`
      SELECT * FROM cash_book ${where}
      ORDER BY transaction_at DESC LIMIT 200
    `, params);

    // Calculate totals
    const totalIn = result.rows.filter(r => r.type === 'in').reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalOut = result.rows.filter(r => r.type === 'out').reduce((s, r) => s + parseFloat(r.amount), 0);

    res.json({
      success: true,
      data: result.rows,
      summary: {
        totalIn: Math.round(totalIn),
        totalOut: Math.round(totalOut),
        balance: Math.round(totalIn - totalOut),
        entries: result.rows.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cashbook — add entry ────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, type, amount, category, description, referenceNo, reservationId, paymentMode, addedBy } = req.body;
    if (!type || !amount || !description) {
      return res.status(400).json({ error: 'type, amount and description required' });
    }
    const result = await db.query(`
      INSERT INTO cash_book (hotel_id, type, amount, category, description, reference_no, reservation_id, payment_mode, added_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [hotelId, type, amount, category, description, referenceNo, reservationId, paymentMode || 'cash', addedBy]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cashbook/daily-summary — daily cash summary ──────
router.get('/daily-summary', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;
    const result = await db.query(`
      SELECT date,
        SUM(CASE WHEN type='in' THEN amount ELSE 0 END) as total_in,
        SUM(CASE WHEN type='out' THEN amount ELSE 0 END) as total_out,
        SUM(CASE WHEN type='in' THEN amount ELSE -amount END) as net,
        COUNT(*) as entries
      FROM cash_book
      WHERE hotel_id = $1 AND date BETWEEN $2 AND $3
      GROUP BY date ORDER BY date DESC
    `, [hotelId, startDate, endDate]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

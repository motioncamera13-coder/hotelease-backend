const express = require('express');
const router = express.Router();
const db = require('../config/database');

function genVoucherNo(type) {
  const d = new Date();
  const prefix = { payment:'PV', receipt:'RV', journal:'JV', contra:'CV', purchase:'PUR', expense:'EXP' };
  return `${prefix[type]||'VCH'}${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${Math.floor(Math.random()*9000)+1000}`;
}

// ── GET /api/vouchers ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, type, status, startDate, endDate } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today;

    let q = `SELECT v.*, res.reservation_no FROM vouchers v
             LEFT JOIN reservations res ON v.reservation_id = res.id
             WHERE v.hotel_id = $1 AND v.date BETWEEN $2 AND $3`;
    const params = [hotelId, start, end];
    let idx = 4;
    if (type) { q += ` AND v.voucher_type = $${idx++}`; params.push(type); }
    if (status) { q += ` AND v.status = $${idx++}`; params.push(status); }
    q += ' ORDER BY v.created_at DESC';

    const result = await db.query(q, params);
    const totals = result.rows.reduce((acc, v) => {
      acc[v.voucher_type] = (acc[v.voucher_type] || 0) + parseFloat(v.amount);
      return acc;
    }, {});

    res.json({ success: true, data: result.rows, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fixed paths must be registered before /:id.
router.get('/summary/by-type', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;
    if (!hotelId || !startDate || !endDate) {
      return res.status(400).json({ error: 'hotelId, startDate and endDate required' });
    }
    const result = await db.query(`
      SELECT voucher_type, COUNT(*) as count, SUM(amount) as total
      FROM vouchers
      WHERE hotel_id=$1 AND date BETWEEN $2 AND $3 AND status != 'draft'
      GROUP BY voucher_type ORDER BY total DESC
    `, [hotelId, startDate, endDate]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vouchers/:id ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT v.*, res.reservation_no, g.name as guest_name
      FROM vouchers v
      LEFT JOIN reservations res ON v.reservation_id = res.id
      LEFT JOIN guests g ON res.guest_id = g.id
      WHERE v.id = $1
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Voucher not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/vouchers ────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      hotelId, voucherType, partyName, description, amount,
      paymentMode, chequeNo, bankName, referenceNo,
      reservationId, createdBy
    } = req.body;

    if (!voucherType || !description || !amount) {
      return res.status(400).json({ error: 'Voucher type, description and amount required' });
    }

    const voucherNo = genVoucherNo(voucherType);
    const result = await db.query(`
      INSERT INTO vouchers (hotel_id, voucher_no, voucher_type, party_name, description,
        amount, payment_mode, cheque_no, bank_name, reference_no, reservation_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [hotelId, voucherNo, voucherType, partyName, description, amount,
        paymentMode, chequeNo, bankName, referenceNo, reservationId, createdBy]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/vouchers/:id/approve ──────────────────────────
router.patch('/:id/approve', async (req, res) => {
  try {
    const { approvedBy } = req.body;
    await db.query(`
      UPDATE vouchers SET status='approved', approved_by=$1, approved_at=NOW()
      WHERE id=$2
    `, [approvedBy, req.params.id]);
    res.json({ success: true, message: 'Voucher approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/vouchers/:id/post ──────────────────────────────
router.patch('/:id/post', async (req, res) => {
  try {
    await db.query(`UPDATE vouchers SET status='posted' WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Voucher posted to accounts' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vouchers/summary/by-type ────────────────────────
router.get('/summary/by-type', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;
    const result = await db.query(`
      SELECT voucher_type, COUNT(*) as count, SUM(amount) as total
      FROM vouchers
      WHERE hotel_id=$1 AND date BETWEEN $2 AND $3 AND status != 'draft'
      GROUP BY voucher_type ORDER BY total DESC
    `, [hotelId, startDate, endDate]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

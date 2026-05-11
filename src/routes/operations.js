const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ── Room Swap ─────────────────────────────────────────────────
router.post('/swap', async (req, res) => {
  try {
    const { reservationId, fromRoomId, toRoomId, reason, swappedBy, hotelId } = req.body;
    const conflict = await db.query(`
      SELECT 1 FROM reservation_rooms rr
      JOIN reservations res ON rr.reservation_id = res.id
      WHERE rr.room_id = $1 AND res.status IN ('confirmed','checked_in')
        AND res.checkin_date <= CURRENT_DATE AND res.checkout_date > CURRENT_DATE
        AND res.id != $2
    `, [toRoomId, reservationId]);
    if (conflict.rows.length > 0) return res.status(409).json({ error: 'Target room is occupied' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE reservation_rooms SET room_id=$1 WHERE reservation_id=$2 AND room_id=$3`, [toRoomId, reservationId, fromRoomId]);
      await client.query(`INSERT INTO room_swaps (hotel_id,reservation_id,from_room_id,to_room_id,reason,swapped_by) VALUES ($1,$2,$3,$4,$5,$6)`, [hotelId, reservationId, fromRoomId, toRoomId, reason, swappedBy]);
      await client.query(`INSERT INTO housekeeping (room_id,status,notes,updated_at) VALUES ($1,'dirty','Vacated after swap',NOW()) ON CONFLICT (room_id) DO UPDATE SET status='dirty',notes='Vacated after swap',updated_at=NOW()`, [fromRoomId]);
      await client.query('COMMIT');
      res.json({ success: true, message: 'Room swapped successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/swaps', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(`
      SELECT rs.*, r.reservation_no, fr.room_number as from_room,
             tr.room_number as to_room, g.name as guest_name
      FROM room_swaps rs
      JOIN reservations r ON rs.reservation_id = r.id
      JOIN rooms fr ON rs.from_room_id = fr.id
      JOIN rooms tr ON rs.to_room_id = tr.id
      LEFT JOIN guests g ON r.guest_id = g.id
      WHERE rs.hotel_id = $1 ORDER BY rs.swapped_at DESC LIMIT 50
    `, [hotelId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cash Book ─────────────────────────────────────────────────
router.get('/cashbook', async (req, res) => {
  try {
    const { hotelId, startDate, endDate } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today;
    const result = await db.query(`
      SELECT cb.*, res.reservation_no FROM cash_book cb
      LEFT JOIN reservations res ON cb.reservation_id = res.id
      WHERE cb.hotel_id = $1 AND cb.date BETWEEN $2 AND $3
      ORDER BY cb.created_at DESC
    `, [hotelId, start, end]);
    const totalCredit = result.rows.filter(r => r.type === 'credit').reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalDebit = result.rows.filter(r => r.type === 'debit').reduce((s, r) => s + parseFloat(r.amount), 0);
    res.json({ success: true, data: result.rows, summary: { totalCredit, totalDebit, balance: totalCredit - totalDebit } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cashbook', async (req, res) => {
  try {
    const { hotelId, type, category, description, amount, paymentMode, referenceNo, reservationId, addedBy } = req.body;
    if (!['credit', 'debit'].includes(type)) return res.status(400).json({ error: 'Type must be credit or debit' });
    const result = await db.query(`
      INSERT INTO cash_book (hotel_id,type,category,description,amount,payment_mode,reference_no,reservation_id,added_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [hotelId, type, category, description, amount, paymentMode, referenceNo, reservationId, addedBy]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── C-Form ────────────────────────────────────────────────────
router.get('/cforms', async (req, res) => {
  try {
    const { hotelId, date } = req.query;
    let q = `SELECT cf.*, res.reservation_no FROM c_forms cf LEFT JOIN reservations res ON cf.reservation_id = res.id WHERE cf.hotel_id = $1`;
    const params = [hotelId];
    if (date) { q += ` AND cf.checkin_date = $2`; params.push(date); }
    q += ' ORDER BY cf.created_at DESC LIMIT 100';
    const result = await db.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cforms', async (req, res) => {
  try {
    const { hotelId, reservationId, guestId, guestName, fatherName, nationality, idType, idNumber, dateOfBirth, gender, address, city, state, mobile, purposeOfVisit, checkinDate, checkoutDate, roomNo } = req.body;
    const d = new Date();
    const formNo = `CF${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${Math.floor(Math.random()*9000)+1000}`;
    const result = await db.query(`
      INSERT INTO c_forms (hotel_id,reservation_id,guest_id,form_no,guest_name,father_name,nationality,id_type,id_number,date_of_birth,gender,address,city,state,mobile,purpose_of_visit,checkin_date,checkout_date,room_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
    `, [hotelId,reservationId,guestId,formNo,guestName,fatherName,nationality||'Indian',idType,idNumber,dateOfBirth,gender,address,city,state,mobile,purposeOfVisit||'Tourism',checkinDate,checkoutDate,roomNo]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/cforms/:id/submit', async (req, res) => {
  try {
    await db.query(`UPDATE c_forms SET submitted_to_police=true, submitted_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'C-Form submitted to police' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Folio ─────────────────────────────────────────────────────
router.get('/folio/:reservationId', async (req, res) => {
  try {
    const entries = await db.query(`SELECT * FROM folio WHERE reservation_id=$1 ORDER BY created_at`, [req.params.reservationId]);
    const resDetails = await db.query(`
      SELECT r.*, g.name as guest_name, rt.name as room_type_name, a.name as agent_name
      FROM reservations r
      LEFT JOIN guests g ON r.guest_id = g.id
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN agents a ON r.agent_id = a.id
      WHERE r.id = $1
    `, [req.params.reservationId]);
    const totalCharges = entries.rows.filter(e => e.type === 'charge').reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalPayments = entries.rows.filter(e => e.type === 'payment').reduce((s, e) => s + parseFloat(e.amount), 0);
    res.json({ success: true, data: { reservation: resDetails.rows[0], entries: entries.rows, summary: { totalCharges, totalPayments, balance: totalCharges - totalPayments } } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/folio', async (req, res) => {
  try {
    const { hotelId, reservationId, type, description, amount, addedBy } = req.body;
    const prev = await db.query(`SELECT COALESCE(SUM(CASE WHEN type='charge' THEN amount ELSE -amount END),0) as bal FROM folio WHERE reservation_id=$1`, [reservationId]);
    const prevBal = parseFloat(prev.rows[0].bal);
    const newBal = type === 'charge' ? prevBal + parseFloat(amount) : prevBal - parseFloat(amount);
    const result = await db.query(`INSERT INTO folio (hotel_id,reservation_id,type,description,amount,balance,added_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [hotelId, reservationId, type, description, amount, newBal, addedBy]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

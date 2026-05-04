const express = require('express');
const router = express.Router();
const db = require('../../config/database');

function generateFormNo() {
  const d = new Date();
  return `CF${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${Math.floor(Math.random()*9000)+1000}`;
}

// ── GET /api/cforms — get all forms ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, date, submitted } = req.query;
    let where = 'WHERE hotel_id = $1';
    const params = [hotelId];
    let i = 2;
    if (date) { where += ` AND checkin_date = $${i++}`; params.push(date); }
    if (submitted !== undefined) { where += ` AND submitted = $${i++}`; params.push(submitted === 'true'); }

    const result = await db.query(`
      SELECT cf.*, r.reservation_no
      FROM c_forms cf
      LEFT JOIN reservations r ON cf.reservation_id = r.id
      ${where} ORDER BY cf.created_at DESC
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cforms — create c-form ──────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      hotelId, reservationId, guestId, guestName, guestPhone,
      nationality, idType, idNumber, dob, gender,
      address, city, state, purposeOfVisit,
      arrivalFrom, proceedingTo, checkinDate, checkoutDate, roomNumber
    } = req.body;

    const formNo = generateFormNo();
    const result = await db.query(`
      INSERT INTO c_forms (
        hotel_id, reservation_id, guest_id, form_no,
        guest_name, guest_phone, nationality, id_type, id_number,
        dob, gender, address, city, state, purpose_of_visit,
        arrival_from, proceeding_to, checkin_date, checkout_date, room_number
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [hotelId, reservationId, guestId, formNo, guestName, guestPhone,
        nationality || 'Indian', idType, idNumber, dob, gender,
        address, city, state, purposeOfVisit || 'Tourism',
        arrivalFrom, proceedingTo, checkinDate, checkoutDate, roomNumber]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/cforms/:id/submit — mark as submitted ──────────
router.patch('/:id/submit', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE c_forms SET submitted = true, submitted_at = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cforms/pending — pending submissions ─────────────
router.get('/pending', async (req, res) => {
  try {
    const { hotelId } = req.query;
    const result = await db.query(`
      SELECT cf.*, r.reservation_no FROM c_forms cf
      LEFT JOIN reservations r ON cf.reservation_id = r.id
      WHERE cf.hotel_id = $1 AND cf.submitted = false
      ORDER BY cf.checkin_date DESC
    `, [hotelId]);
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

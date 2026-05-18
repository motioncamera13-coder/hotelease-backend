const express = require('express');
const router = express.Router();
const db = require('../config/database');

// POST /api/guests - create guest (always create new if forceNew=true)
router.post('/', async (req, res) => {
  try {
    const { hotelId, name, phone, email, forceNew } = req.body;

    if (!name) return res.status(400).json({ error: 'Guest name required' });

    // If forceNew - always create new guest record
    if (forceNew) {
      const result = await db.query(
      `INSERT INTO guests (hotel_id, name, phone, email, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`,
        [hotelId, name.trim(), phone || null, email || null]
      );
      return res.json({ success: true, data: result.rows[0] });
    }

    // Check if guest exists with same phone
    if (phone) {
      const existing = await db.query(
        'SELECT * FROM guests WHERE hotel_id = $1 AND phone = $2 LIMIT 1',
        [hotelId, phone]
      );
      if (existing.rows[0]) {
        // Update name and return existing
        const updated = await db.query(
          'UPDATE guests SET name = $1 WHERE id = $2 RETURNING *',
          [name.trim(), existing.rows[0].id]
        );
        return res.json({ success: true, data: updated.rows[0] });
      }
    }

    // Create new guest
    const result = await db.query(
      `INSERT INTO guests (hotel_id, name, phone, email, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [hotelId, name.trim(), phone || null, email || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Guest create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guests - get all guests for hotel
router.get('/', async (req, res) => {
  try {
    const { hotelId, search } = req.query;
    let query = 'SELECT * FROM guests WHERE hotel_id = $1';
    const params = [hotelId];

    if (search) {
      query += ' AND (name ILIKE $2 OR phone ILIKE $2)';
      params.push('%' + search + '%');
    }

    query += ' ORDER BY created_at DESC LIMIT 100';
    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

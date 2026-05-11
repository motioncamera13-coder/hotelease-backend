const express = require('express');
const router = express.Router();
const db = require('../config/database');

function genSlipNo() {
  const d = new Date();
  return `REQ${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${Math.floor(Math.random()*9000)+1000}`;
}

// ── GET /api/requisitions ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { hotelId, status, department } = req.query;
    let q = `SELECT rs.*, COUNT(ri.id) as item_count,
               COALESCE(SUM(ri.estimated_cost * ri.quantity), 0) as total_cost
             FROM requisition_slips rs
             LEFT JOIN requisition_items ri ON rs.id = ri.requisition_id
             WHERE rs.hotel_id = $1`;
    const params = [hotelId];
    let idx = 2;
    if (status) { q += ` AND rs.status = $${idx++}`; params.push(status); }
    if (department) { q += ` AND rs.department = $${idx++}`; params.push(department); }
    q += ' GROUP BY rs.id ORDER BY rs.created_at DESC LIMIT 100';
    const result = await db.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/requisitions/:id ─────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const slip = await db.query('SELECT * FROM requisition_slips WHERE id=$1', [req.params.id]);
    if (!slip.rows[0]) return res.status(404).json({ error: 'Not found' });
    const items = await db.query('SELECT * FROM requisition_items WHERE requisition_id=$1', [req.params.id]);
    res.json({ success: true, data: { ...slip.rows[0], items: items.rows } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/requisitions ────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { hotelId, department, requestedBy, priority, notes, items } = req.body;
    if (!department || !requestedBy || !items?.length) {
      return res.status(400).json({ error: 'Department, requested by and items are required' });
    }

    const slipNo = genSlipNo();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const slipRes = await client.query(`
        INSERT INTO requisition_slips (hotel_id, slip_no, department, requested_by, priority, notes)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [hotelId, slipNo, department, requestedBy, priority || 'normal', notes]);

      const slip = slipRes.rows[0];
      for (const item of items) {
        await client.query(`
          INSERT INTO requisition_items (requisition_id, item_name, quantity, unit, estimated_cost, notes)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [slip.id, item.name, item.quantity, item.unit, item.estimatedCost, item.notes]);
      }

      await client.query('COMMIT');
      res.status(201).json({ success: true, data: { ...slip, slipNo } });
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

// ── PATCH /api/requisitions/:id/status ───────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, approvedBy, issuedQty } = req.body;
    const validStatuses = ['pending', 'approved', 'issued', 'rejected'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await db.query(`
      UPDATE requisition_slips SET
        status = $1,
        approved_by = CASE WHEN $1 IN ('approved','rejected') THEN $2 ELSE approved_by END,
        approved_at = CASE WHEN $1 IN ('approved','rejected') THEN NOW() ELSE approved_at END,
        issued_at = CASE WHEN $1 = 'issued' THEN NOW() ELSE issued_at END
      WHERE id = $3
    `, [status, approvedBy, req.params.id]);

    if (status === 'issued' && issuedQty) {
      for (const [itemId, qty] of Object.entries(issuedQty)) {
        await db.query('UPDATE requisition_items SET issued_qty=$1 WHERE id=$2', [qty, itemId]);
      }
    }

    res.json({ success: true, message: `Requisition ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

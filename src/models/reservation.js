const db = require('../config/database');

// ── Generate reservation number ────────────────────────────────
function generateReservationNo() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `HE${y}${m}${d}${rand}`;
}

// ── Check availability ─────────────────────────────────────────
async function checkAvailability(hotelId, roomTypeId, checkinDate, checkoutDate, roomsNeeded) {
  const res = await db.query(`
    SELECT COUNT(r.id) as total_rooms,
           COUNT(r.id) - COUNT(DISTINCT rr.room_id) as available_rooms
    FROM rooms r
    LEFT JOIN reservation_rooms rr ON r.id = rr.room_id
    LEFT JOIN reservations res ON rr.reservation_id = res.id
      AND res.status NOT IN ('cancelled', 'checked_out')
      AND res.checkin_date < $3
      AND res.checkout_date > $2
    WHERE r.hotel_id = $1
      AND r.room_type_id = $4
      AND r.status = 'available'
  `, [hotelId, checkinDate, checkoutDate, roomTypeId]);

  const { total_rooms, available_rooms } = res.rows[0];
  const hotel = await db.query('SELECT buffer_rooms FROM hotels WHERE id = $1', [hotelId]);
  const buffer = hotel.rows[0]?.buffer_rooms || 4;
  const effectiveAvailable = parseInt(available_rooms) - buffer;

  return {
    available: effectiveAvailable >= roomsNeeded,
    availableRooms: Math.max(0, effectiveAvailable),
    totalRooms: parseInt(total_rooms),
    bufferRooms: buffer,
  };
}

// ── Create reservation ─────────────────────────────────────────
async function createReservation({
  hotelId, agentId, guestId, roomTypeId, seasonId,
  checkinDate, checkoutDate, roomsCount, plan,
  ratePerNight, source = 'whatsapp', specialRequests
}) {
  const reservationNo = generateReservationNo();

  const res = await db.query(`
    INSERT INTO reservations (
      hotel_id, reservation_no, agent_id, guest_id, room_type_id,
      season_id, checkin_date, checkout_date, rooms_count,
      plan, rate_per_night, source, special_requests
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `, [hotelId, reservationNo, agentId, guestId, roomTypeId,
      seasonId, checkinDate, checkoutDate, roomsCount,
      plan, ratePerNight, source, specialRequests]);

  // Log activity
  await db.query(`
    INSERT INTO activity_log (hotel_id, action, entity_type, entity_id, details)
    VALUES ($1, 'reservation_created', 'reservation', $2, $3)
  `, [hotelId, res.rows[0].id, JSON.stringify({ reservation_no: reservationNo, source })]);

  return res.rows[0];
}

// ── Get reservation by ID or number ───────────────────────────
async function getReservation(identifier) {
  const isUUID = identifier.match(/^[0-9a-f-]{36}$/i);
  const field = isUUID ? 'r.id' : 'r.reservation_no';

  const res = await db.query(`
    SELECT r.*,
           rt.name as room_type_name,
           a.name as agent_name, a.phone as agent_phone, a.category as agent_category,
           g.name as guest_name, g.phone as guest_phone,
           h.name as hotel_name
    FROM reservations r
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN agents a ON r.agent_id = a.id
    LEFT JOIN guests g ON r.guest_id = g.id
    LEFT JOIN hotels h ON r.hotel_id = h.id
    WHERE ${field} = $1
  `, [identifier]);

  if (!res.rows[0]) return null;

  // Get extra charges
  const extras = await db.query(`
    SELECT * FROM extra_charges WHERE reservation_id = $1 ORDER BY added_at
  `, [res.rows[0].id]);

  // Get payments
  const payments = await db.query(`
    SELECT * FROM payments WHERE reservation_id = $1 ORDER BY payment_date
  `, [res.rows[0].id]);

  return {
    ...res.rows[0],
    extras: extras.rows,
    payments: payments.rows,
  };
}

// ── Get today's check-ins ──────────────────────────────────────
async function getTodayCheckins(hotelId) {
  const res = await db.query(`
    SELECT r.*, g.name as guest_name, g.phone as guest_phone,
           rt.name as room_type_name, a.name as agent_name
    FROM reservations r
    LEFT JOIN guests g ON r.guest_id = g.id
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.hotel_id = $1
      AND r.checkin_date = CURRENT_DATE
      AND r.status = 'confirmed'
    ORDER BY r.created_at
  `, [hotelId]);
  return res.rows;
}

// ── Get today's check-outs ─────────────────────────────────────
async function getTodayCheckouts(hotelId) {
  const res = await db.query(`
    SELECT r.*, g.name as guest_name, g.phone as guest_phone,
           rt.name as room_type_name, a.name as agent_name
    FROM reservations r
    LEFT JOIN guests g ON r.guest_id = g.id
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.hotel_id = $1
      AND r.checkout_date = CURRENT_DATE
      AND r.status = 'checked_in'
    ORDER BY r.created_at
  `, [hotelId]);
  return res.rows;
}

// ── Update reservation status ──────────────────────────────────
async function updateStatus(reservationId, status) {
  const res = await db.query(`
    UPDATE reservations SET status = $1, updated_at = NOW()
    WHERE id = $2 RETURNING *
  `, [status, reservationId]);
  return res.rows[0];
}

// ── Add extra charge ───────────────────────────────────────────
async function addExtraCharge({
  reservationId, chargeType, description,
  quantity, nights, rate, isFree = false, personAge, addedBy = 'agent'
}) {
  const res = await db.query(`
    INSERT INTO extra_charges (
      reservation_id, charge_type, description,
      quantity, nights, rate, is_free, person_age, added_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `, [reservationId, chargeType, description,
      quantity, nights, rate, isFree, personAge, addedBy]);
  return res.rows[0];
}

// ── Generate bill ──────────────────────────────────────────────
async function generateBill(reservationId) {
  const reservation = await getReservation(reservationId);
  if (!reservation) throw new Error('Reservation not found');

  const roomCharges = reservation.rate_per_night * reservation.rooms_count * reservation.nights;
  const extraCharges = reservation.extras
    .filter(e => !e.is_free)
    .reduce((sum, e) => sum + parseFloat(e.total), 0);

  const subtotal = roomCharges + extraCharges;
  const gstRate = subtotal > 7500 ? 18 : 12;
  const gstAmount = (subtotal * gstRate) / 100;
  const total = subtotal + gstAmount;

  const paidAmount = reservation.payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  const balance = total - paidAmount;

  const billNo = 'BILL' + Date.now().toString().slice(-8);

  const bill = await db.query(`
    INSERT INTO bills (
      reservation_id, bill_no, room_charges, extra_charges,
      subtotal, gst_rate, gst_amount, total, paid_amount, balance
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (reservation_id) DO UPDATE SET
      room_charges = $3, extra_charges = $4, subtotal = $5,
      gst_rate = $6, gst_amount = $7, total = $8,
      paid_amount = $9, balance = $10
    RETURNING *
  `, [reservationId, billNo, roomCharges, extraCharges,
      subtotal, gstRate, gstAmount, total, paidAmount, balance]);

  return { ...bill.rows[0], reservation };
}

// ── Get all reservations ───────────────────────────────────────
async function getAllReservations(hotelId, filters = {}) {
  let where = 'WHERE r.hotel_id = $1';
  const params = [hotelId];
  let paramCount = 1;

  if (filters.status) {
    paramCount++;
    where += ` AND r.status = $${paramCount}`;
    params.push(filters.status);
  }
  if (filters.date) {
    paramCount++;
    where += ` AND r.checkin_date = $${paramCount}`;
    params.push(filters.date);
  }
  if (filters.agentId) {
    paramCount++;
    where += ` AND r.agent_id = $${paramCount}`;
    params.push(filters.agentId);
  }

  const res = await db.query(`
    SELECT r.*, rt.name as room_type_name,
           a.name as agent_name, g.name as guest_name, g.phone as guest_phone
    FROM reservations r
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN agents a ON r.agent_id = a.id
    LEFT JOIN guests g ON r.guest_id = g.id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT 100
  `, params);

  return res.rows;
}

module.exports = {
  checkAvailability,
  createReservation,
  getReservation,
  getTodayCheckins,
  getTodayCheckouts,
  updateStatus,
  addExtraCharge,
  generateBill,
  getAllReservations,
};

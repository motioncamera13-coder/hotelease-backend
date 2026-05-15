const express = require('express');
const { sendInstantCheckin, sendInstantCheckout } = require('../utils/whatsapp-scheduler');
const router = express.Router();
const Reservation = require('../models/reservation');
const RatesModel = require('../models/rates');
const db = require('../config/database');

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

    // Send WhatsApp via bot service
    let waStatus = null;
    const BOT_URL = process.env.BOT_URL || 'https://hotelease-pms.onrender.com/api/reservations';

    if (status === 'checked_in' || status === 'checked_out') {
      try {
        // Get reservation details
        const resDetails = await db.query(`
          SELECT r.*, g.name as guest_name, g.phone as guest_phone,
                 rt.name as room_type_name, h.name as hotel_name,
                 h.wifi_name, h.google_review_link,
                 STRING_AGG(rm.room_number, ', ' ORDER BY rm.room_number) as room_numbers
          FROM reservations r
          LEFT JOIN guests g ON r.guest_id = g.id
          LEFT JOIN room_types rt ON r.room_type_id = rt.id
          LEFT JOIN hotels h ON r.hotel_id = h.id
          LEFT JOIN reservation_rooms rr ON r.id = rr.reservation_id
          LEFT JOIN rooms rm ON rr.room_id = rm.id
          WHERE r.id = $1
          GROUP BY r.id, g.name, g.phone, rt.name, h.name, h.wifi_name, h.google_review_link
        `, [req.params.id]);

        const res2 = resDetails.rows[0];
        if (res2?.guest_phone) {
          const phone = res2.guest_phone.replace(/^\+/, '').replace(/\s/g, '');
          const nights = res2.nights || 1;
          const rooms = res2.rooms_count || 1;
          const rate = parseFloat(res2.rate_per_night || 0);
          const roomCharges = Math.round(rate * rooms * nights);
          const gstRate = rate >= 7500 ? 18 : 12;
          const gstAmount = Math.round(roomCharges * gstRate / 100);
          const total = roomCharges + gstAmount;

          const checkoutDate = new Date(res2.checkout_date).toLocaleDateString('en-IN', {
            day: 'numeric', month: 'short', year: 'numeric'
          });

          const axios = require('axios');

          if (status === 'checked_in') {
            await axios.post(BOT_URL + '/send-checkin', {
              phone,
              guestName: res2.guest_name || 'Guest',
              hotelName: res2.hotel_name || 'Hotel',
              room: res2.room_numbers ? 'Room ' + res2.room_numbers : res2.room_type_name,
              checkout: checkoutDate,
              plan: res2.plan === 'CP' ? 'CP - With Breakfast' :
                    res2.plan === 'MAP' ? 'MAP - Breakfast and Dinner' : 'EP - Room Only',
              wifi: res2.wifi_name || process.env.WIFI_NAME || 'Ask reception'
            });
            waStatus = 'checkin_sent';
          } else {
            await axios.post(BOT_URL + '/send-checkout', {
              phone,
              guestName: res2.guest_name || 'Guest',
              hotelName: res2.hotel_name || 'Hotel',
              roomCharges: roomCharges.toLocaleString(),
              gst: gstAmount.toLocaleString(),
              total: total.toLocaleString(),
              reviewLink: res2.google_review_link || ''
            });
            waStatus = 'checkout_sent';
          }
          console.log('WhatsApp ' + status + ' message sent via bot to', phone);
        }
      } catch (err) {
        waStatus = 'failed: ' + err.message;
        console.error('WhatsApp error:', err.message);
      }
    }

    res.json({ success: true, data: reservation, whatsapp: waStatus });
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

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

// ── POST /api/reservations/send-booking-email ─────────────────
router.post('/send-booking-email', async (req, res) => {
  try {
    const {
      to, confirmNo, agentName, agentPhone, guestName, guestMobile,
      ciDate, coDate, nights, rooms, roomType, adults, kids,
      kidAges, plan, rate, total
    } = req.body;

    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    const bookingEmailTo = to || process.env.BOOKING_EMAIL_TO || 'sukhsagarregencysml@gmail.com';

    console.log('Booking email API: preparing Gmail send', {
      to: bookingEmailTo,
      hasEmailUser: Boolean(emailUser),
      hasEmailPass: Boolean(emailPass)
    });

    if (!emailUser || !emailPass) {
      return res.status(500).json({ error: 'EMAIL_USER or EMAIL_PASS is missing on PMS backend' });
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: resend,
        pass: re_dgQyRgvz_8qv4NxMWBTVjS2EnB8yjYSV4,
      }
    });

    const kidText = Array.isArray(kidAges) && kidAges.length ? ` (${kidAges.join(', ')} yrs)` : '';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
        <h2 style="margin:0 0 12px">New Booking Confirmed</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Confirmation No</td><td style="padding:6px;border-bottom:1px solid #eee"><b>${confirmNo || ''}</b></td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Agent</td><td style="padding:6px;border-bottom:1px solid #eee">${agentName || ''} (${agentPhone || ''})</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Guest</td><td style="padding:6px;border-bottom:1px solid #eee">${guestName || ''} (${guestMobile || ''})</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Check-in</td><td style="padding:6px;border-bottom:1px solid #eee">${ciDate || ''}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Check-out</td><td style="padding:6px;border-bottom:1px solid #eee">${coDate || ''}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Nights</td><td style="padding:6px;border-bottom:1px solid #eee">${nights || ''}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Rooms</td><td style="padding:6px;border-bottom:1px solid #eee">${rooms || ''} x ${roomType || ''}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Adults / Kids</td><td style="padding:6px;border-bottom:1px solid #eee">${adults || 1} / ${kids || 0}${kidText}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Plan</td><td style="padding:6px;border-bottom:1px solid #eee">${plan || ''}</td></tr>
          <tr><td style="padding:6px;border-bottom:1px solid #eee">Rate</td><td style="padding:6px;border-bottom:1px solid #eee">Rs.${Number(rate || 0).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:8px;background:#f4f4f4"><b>Total</b></td><td style="padding:8px;background:#f4f4f4"><b>Rs.${Number(total || 0).toLocaleString('en-IN')}</b></td></tr>
        </table>
      </div>
    `;

    console.log('Booking email API: sending Gmail message', { to: bookingEmailTo });
    const info = await withTimeout(
      transporter.sendMail({
        from: `"HotelEase PMS" <${emailUser}>`,
        to: bookingEmailTo,
        subject: `New Booking - ${guestName || 'Guest'} - ${ciDate || ''}`,
        html
      }),
      20000,
      'PMS Gmail send timed out after 20 seconds'
    );

    console.log('Booking email API: sent', { messageId: info.messageId, to: bookingEmailTo });
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error('Booking email API error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

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

// ── POST /api/reservations/direct — create from dashboard ─────
router.post('/direct', async (req, res) => {
  try {
    const {
      hotelId, guestId, agentId, roomTypeId, seasonId,
      checkinDate, checkoutDate, roomsCount, plan,
      ratePerNight, source, specialRequests
    } = req.body;

    const { createReservation } = require('../models/reservation');
    const reservation = await createReservation({
      hotelId, agentId: agentId || null, guestId: guestId || null,
      roomTypeId, seasonId: seasonId || null,
      checkinDate, checkoutDate,
      roomsCount: parseInt(roomsCount) || 1,
      plan: plan || 'EP',
      ratePerNight: parseFloat(ratePerNight) || 0,
      source: source || 'walk_in',
      specialRequests
    });

    // Send opt-in request to guest via bot
    try {
      const BOT_URL = process.env.BOT_URL || 'https://hotelease-pms.onrender.com/api/reservations';
      const axios = require('axios');

      // Get guest phone and hotel details
      if (guestId) {
        const guestData = await db.query(
          'SELECT g.phone, g.name, h.name as hotel_name, h.wifi_name FROM guests g JOIN hotels h ON h.id = $1 WHERE g.id = $2',
          [hotelId, guestId]
        );
        const guest = guestData.rows[0];
        if (guest?.phone) {
          const phone = guest.phone.replace(/^\+/, '').replace(/\s/g, '');
          await axios.post(BOT_URL + '/send-optin', {
            phone,
            guestName: guest.name,
            hotelName: guest.hotel_name,
            reservationId: reservation.id,
            checkout: new Date(checkoutDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
            plan: plan || 'EP',
            wifi: guest.wifi_name || process.env.WIFI_NAME || 'Ask reception'
          });
          console.log('Opt-in request sent to', phone);
        }
      }
    } catch (optinErr) {
      console.error('Opt-in send error:', optinErr.message);
    }

    res.status(201).json({ success: true, data: reservation });
  } catch (err) {
    console.error('Direct booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reservations/test-whatsapp — test WA message ────
router.post('/test-whatsapp', async (req, res) => {
  try {
    const { phone, hotelName } = req.body;
    const { sendWAMessage } = require('../utils/whatsapp-scheduler');
    const msg = `Test message from HotelEase!\n\nIf you received this, WhatsApp is working correctly for ${hotelName || 'your hotel'}. ✅`;
    await sendWAMessage(phone, msg);
    res.json({ success: true, message: 'Test WhatsApp sent to ' + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /api/reservations/test-whatsapp-raw -- raw Meta API test
router.post('/test-whatsapp-raw', async (req, res) => {
  try {
    const { phone } = req.body;
    const axios = require('axios');
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, '').replace(/\s/g, ''),
      type: 'template',
      template: {
        name: 'hotel_checkin',
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: 'Hotel Sukhsagar Regency' },
            { type: 'text', text: 'Mr Test Guest' },
            { type: 'text', text: 'Room 304' },
            { type: 'text', text: '07 May 2026' },
            { type: 'text', text: 'MAP - Breakfast and Dinner' },
            { type: 'text', text: 'SukhSagar@2026' }
          ]
        }]
      }
    };

    const result = await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json({ success: true, meta_response: result.data });
  } catch (err) {
    res.status(500).json({ 
      error: err.message,
      meta_error: err.response?.data 
    });
  }
});

// ── POST /api/reservations/send-checkin ───────────────────────
router.post('/send-checkin', async (req, res) => {
  try {
    const { phone, guestName, hotelName, room, checkout, plan, wifi } = req.body;
    const axios = require('axios');
    const msg =
      `Welcome to ${hotelName}!\n\n` +
      `Dear ${guestName},\n\n` +
      `You are now checked in. Here are your details:\n\n` +
      `Room: ${room}\n` +
      `Check-out: ${checkout}\n` +
      `Plan: ${plan}\n` +
      `WiFi: ${wifi}\n\n` +
      `For assistance please call reception.\n\n` +
      `We wish you a wonderful stay!\n` +
      `Team ${hotelName}`;

    await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.replace(/^\+/, '').replace(/\s/g, ''),
        type: 'text',
        text: { body: msg }
      },
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, message: 'Check-in message sent to ' + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reservations/send-checkout ──────────────────────
router.post('/send-checkout', async (req, res) => {
  try {
    const { phone, guestName, hotelName, roomCharges, gst, total, reviewLink } = req.body;
    const axios = require('axios');
    const msg =
      `Dear ${guestName},\n\n` +
      `Thank you for staying at ${hotelName}!\n\n` +
      `Bill summary:\n` +
      `Room charges: Rs.${roomCharges}\n` +
      `GST: Rs.${gst}\n` +
      `Total: Rs.${total}\n\n` +
      `We hope to see you again!\n` +
      (reviewLink ? `\nPlease share your experience:\n${reviewLink}` : '');

    await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.replace(/^\+/, '').replace(/\s/g, ''),
        type: 'text',
        text: { body: msg }
      },
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, message: 'Checkout message sent to ' + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reservations/send-optin ─────────────────────────
router.post('/send-optin', async (req, res) => {
  try {
    const { phone, guestName, hotelName } = req.body;
    const axios = require('axios');
    const msg =
      `Dear ${guestName},\n\n` +
      `Your booking at ${hotelName} is confirmed!\n\n` +
      `Reply *YES* to receive your check-in details and updates on WhatsApp.\n\n` +
      `Team ${hotelName}`;

    await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.replace(/^\+/, '').replace(/\s/g, ''),
        type: 'text',
        text: { body: msg }
      },
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, message: 'Opt-in request sent to ' + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

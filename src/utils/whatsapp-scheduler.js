const axios = require('axios');
const db = require('../config/database');
const Reservation = require('../models/reservation');

const WA_URL = `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const HEADERS = {
  Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

function normalizePhone(to) {
  return String(to || '').replace(/^\+/, '').replace(/\s/g, '');
}

function whatsappError(err) {
  const meta = err.response?.data;
  if (meta?.error?.message) return meta.error.message;
  if (meta) return JSON.stringify(meta);
  return err.message;
}

async function sendWAMessage(to, text) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Guest phone is missing');
  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    throw new Error('WhatsApp credentials are missing');
  }

  try {
    const result = await axios.post(WA_URL, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }, { headers: HEADERS });
    console.log(`OK WA sent to ${phone}`);
    return result.data;
  } catch (err) {
    const message = whatsappError(err);
    console.error(`FAIL WA failed to ${phone}:`, message);
    throw new Error(message);
  }
}

// -- Send using approved Meta template -------------------------
async function sendWATemplate(to, templateName, components) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Guest phone is missing');
  if (!templateName) throw new Error('WhatsApp template name is missing');
  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    throw new Error('WhatsApp credentials are missing');
  }

  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: components
      }
    };
    const res = await axios.post(WA_URL, payload, { headers: HEADERS });
    console.log('OK Template sent to ' + phone + ':', res.data?.messages?.[0]?.id);
    return res.data;
  } catch (err) {
    const message = whatsappError(err);
    console.error('FAIL Template failed to ' + phone + ':', message);
    throw new Error(message);
  }
}

function templateComponents(values, order) {
  return [{
    type: 'body',
    parameters: order.map(key => ({ type: 'text', text: String(values[key] ?? '') }))
  }];
}

function templateOrder(envName, defaults) {
  return (process.env[envName] || defaults.join(','))
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function formatPlan(plan) {
  return plan === 'CP' ? 'CP - With Breakfast' :
         plan === 'MAP' ? 'MAP - Breakfast and Dinner' :
         'EP - Room Only';
}

// ── Send check-in messages ────────────────────────────────────
async function sendCheckinMessages() {
  const hotels = await db.query('SELECT * FROM hotels');
  for (const hotel of hotels.rows) {
    const checkins = await Reservation.getTodayCheckins(hotel.id);
    console.log(`📋 ${hotel.name}: ${checkins.length} check-ins today`);

    for (const res of checkins) {
      if (!res.guest_phone) {
        console.log(`⚠ No guest phone for reservation ${res.reservation_no}`);
        continue;
      }

      try {
        await sendInstantCheckin(res.id);
        // Update status to checked_in only after WhatsApp succeeds.
        await Reservation.updateStatus(res.id, 'checked_in');
      } catch (err) {
        console.error(`Check-in send failed for ${res.reservation_no}:`, err.message);
      }
    }
  }
}

// ── Send check-out messages + bill ───────────────────────────
async function sendCheckoutMessages() {
  const hotels = await db.query('SELECT * FROM hotels');
  for (const hotel of hotels.rows) {
    const checkouts = await Reservation.getTodayCheckouts(hotel.id);
    console.log(`📋 ${hotel.name}: ${checkouts.length} check-outs today`);

    for (const res of checkouts) {
      if (!res.guest_phone) continue;

      try {
        await sendInstantCheckout(res.id);
      } catch (err) {
        console.error(`Check-out send failed for ${res.reservation_no}:`, err.message);
      }
    }
  }
}

// ── Send review requests ──────────────────────────────────────
async function sendReviewRequests() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  const hotels = await db.query('SELECT * FROM hotels');
  for (const hotel of hotels.rows) {
    const checkouts = await db.query(`
      SELECT r.*, g.name as guest_name, g.phone as guest_phone
      FROM reservations r
      LEFT JOIN guests g ON r.guest_id = g.id
      WHERE r.hotel_id = $1
        AND r.checkout_date = $2
        AND r.status = 'checked_out'
        AND g.phone IS NOT NULL
    `, [hotel.id, dateStr]);

    for (const res of checkouts.rows) {
      const msg =
        `Dear ${res.guest_name || 'Guest'},\n\n` +
        `We hope you had a great stay at ${hotel.name}! 😊\n\n` +
        `Your feedback means a lot to us. Please take a moment to share your experience:\n\n` +
        `⭐ Google Review:\n${process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/review'}\n\n` +
        `Thank you for choosing us! We look forward to welcoming you again. 🙏`;

      try {
        await sendWAMessage(res.guest_phone, msg);
      } catch (err) {
        console.error(`Review request send failed for ${res.id}:`, err.message);
      }
    }
  }
}

// exports moved to bottom

// ── Instant check-in message (fires immediately) ──────────────
async function sendInstantCheckin(reservationId) {
  const res = await db.query(`
    SELECT r.*, g.name as guest_name, g.phone as guest_phone,
           rt.name as room_type_name, h.name as hotel_name,
           h.phone as hotel_phone, h.city,
           STRING_AGG(rm.room_number, ', ' ORDER BY rm.room_number) as room_numbers,
           h.wifi_name, h.breakfast_time, h.checkout_time
    FROM reservations r
    LEFT JOIN guests g ON r.guest_id = g.id
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN hotels h ON r.hotel_id = h.id
    LEFT JOIN reservation_rooms rr ON r.id = rr.reservation_id
    LEFT JOIN rooms rm ON rr.room_id = rm.id
    WHERE r.id = $1
    GROUP BY r.id, g.name, g.phone, rt.name, h.name, h.phone, h.city, h.wifi_name, h.breakfast_time, h.checkout_time
  `, [reservationId]);

  if (!res.rows[0]) throw new Error('Reservation not found');
  const booking = res.rows[0];

  if (!booking.guest_phone) {
    throw new Error(`No guest phone for reservation ${reservationId}`);
  }

  const checkoutDate = formatDate(booking.checkout_date);

  const rooms = booking.room_numbers ? `Room ${booking.room_numbers}` : booking.room_type_name;

  const wifi = booking.wifi_name || process.env.WIFI_NAME || 'Ask reception';
  const plan = formatPlan(booking.plan);

  const values = {
    hotelName: booking.hotel_name || 'Hotel',
    guestName: booking.guest_name || 'Guest',
    room: rooms,
    checkoutDate,
    plan,
    wifi
  };

  const templateName = process.env.WA_CHECKIN_TEMPLATE || process.env.CHECKIN_TEMPLATE_NAME || 'hotel_checkin';
  const components = templateComponents(
    values,
    templateOrder('WA_CHECKIN_TEMPLATE_PARAMS', ['hotelName', 'guestName', 'room', 'checkoutDate', 'plan', 'wifi'])
  );

  const result = await sendWATemplate(booking.guest_phone, templateName, components);
  console.log('Instant check-in template sent to ' + booking.guest_phone);
  return { success: true, phone: normalizePhone(booking.guest_phone), template: templateName, meta: result };
}

// ── Instant checkout message (fires immediately) ──────────────
async function sendInstantCheckout(reservationId) {
  const res = await db.query(`
    SELECT r.*, g.name as guest_name, g.phone as guest_phone,
           rt.name as room_type_name, h.name as hotel_name,
           h.google_review_link
    FROM reservations r
    LEFT JOIN guests g ON r.guest_id = g.id
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN hotels h ON r.hotel_id = h.id
    WHERE r.id = $1
  `, [reservationId]);

  if (!res.rows[0]) throw new Error('Reservation not found');
  const booking = res.rows[0];
  if (!booking.guest_phone) throw new Error(`No guest phone for reservation ${reservationId}`);

  const bill = await require('../models/reservation').generateBill(reservationId);

  const values = {
    guestName: booking.guest_name || 'Guest',
    hotelName: booking.hotel_name || 'Hotel',
    roomType: booking.room_type_name || 'Room',
    roomCharges: Math.round(bill.room_charges).toLocaleString('en-IN'),
    extraCharges: Math.round(bill.extra_charges || 0).toLocaleString('en-IN'),
    gst: Math.round(bill.gst_amount).toLocaleString('en-IN'),
    total: Math.round(bill.total).toLocaleString('en-IN'),
    reviewLink: booking.google_review_link || process.env.GOOGLE_REVIEW_LINK || 'Not available'
  };

  const templateName = process.env.WA_CHECKOUT_TEMPLATE || process.env.CHECKOUT_TEMPLATE_NAME || 'hotel_checkout';
  const components = templateComponents(
    values,
    templateOrder('WA_CHECKOUT_TEMPLATE_PARAMS', ['guestName', 'hotelName', 'roomCharges', 'gst', 'total', 'reviewLink'])
  );

  const result = await sendWATemplate(booking.guest_phone, templateName, components);
  console.log(`✓ Instant checkout template sent to ${booking.guest_phone}`);
  return { success: true, phone: normalizePhone(booking.guest_phone), template: templateName, meta: result };
}

module.exports = {
  sendCheckinMessages,
  sendCheckoutMessages,
  sendReviewRequests,
  sendInstantCheckin,
  sendInstantCheckout,
  sendWAMessage,
  sendWATemplate
};

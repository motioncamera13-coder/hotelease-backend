const axios = require('axios');
const db = require('../../config/database');
const Reservation = require('../models/reservation');

const WA_URL = `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const HEADERS = {
  Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

async function sendWAMessage(to, text) {
  const phone = to.replace(/^\+/, '').replace(/\s/g, '');
  try {
    await axios.post(WA_URL, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }, { headers: HEADERS });
    console.log(`✓ WA sent to ${phone}`);
  } catch (err) {
    console.error(`✗ WA failed to ${phone}:`, err.response?.data || err.message);
  }
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

      const msg =
        `Welcome to ${hotel.name}! 🏨\n\n` +
        `Dear ${res.guest_name || 'Guest'},\n\n` +
        `Your check-in details:\n` +
        `🛏 Room type: ${res.room_type_name}\n` +
        `📅 Check-out: ${new Date(res.checkout_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}\n` +
        `🍽 Meal plan: ${res.plan}\n\n` +
        `Hotel info:\n` +
        `📶 WiFi: ${process.env.WIFI_NAME || 'Ask reception'}\n` +
        `🍳 Breakfast: 7:30 AM – 10:00 AM\n` +
        `🍽 Restaurant: 12:00 PM – 10:30 PM\n` +
        `📞 Reception: Dial 0 from room\n\n` +
        `We hope you have a wonderful stay! 🙏`;

      await sendWAMessage(res.guest_phone, msg);

      // Update status to checked_in
      await Reservation.updateStatus(res.id, 'checked_in');
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

      // Generate bill
      const bill = await Reservation.generateBill(res.id);

      const msg =
        `Dear ${res.guest_name || 'Guest'},\n\n` +
        `Thank you for staying at ${hotel.name}! 🙏\n\n` +
        `Bill summary:\n` +
        `🛏 ${res.room_type_name} × ${res.rooms_count} room${res.rooms_count > 1 ? 's' : ''} × ${res.nights} nights\n` +
        `💰 Room charges: ₹${bill.room_charges.toLocaleString()}\n` +
        (bill.extra_charges > 0 ? `➕ Extra charges: ₹${bill.extra_charges.toLocaleString()}\n` : '') +
        `📊 GST (${bill.gst_rate}%): ₹${Math.round(bill.gst_amount).toLocaleString()}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💳 Total: ₹${Math.round(bill.total).toLocaleString()}\n\n` +
        `We hope to see you again soon! 😊`;

      await sendWAMessage(res.guest_phone, msg);
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

      await sendWAMessage(res.guest_phone, msg);
    }
  }
}

module.exports = { sendCheckinMessages, sendCheckoutMessages, sendReviewRequests };

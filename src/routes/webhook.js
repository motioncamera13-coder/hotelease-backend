const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const Reservation = require('../models/reservation');
const RatesModel = require('../models/rates');
const axios = require('axios');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'hotel_bot_verify_123';
const WA_URL = `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
const HEADERS = {
  Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};
const ADMIN_PHONE = process.env.ADMIN_PHONE || '919816003322';
const HOTEL_ID = process.env.HOTEL_ID;
const MAX_ROOMS = 5;
const FY_START = new Date('2026-04-01');
const FY_END = new Date('2027-03-31');

// In-memory sessions
const sessions = {};

// ── Webhook verification ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✓ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming messages ──────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    const msg = messages[0];
    if (msg.type !== 'text') return;
    const from = msg.from;
    const text = msg.text?.body || '';
    console.log(`📨 From ${from}: ${text}`);
    await handleMessage(from, text);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Send WhatsApp message ──────────────────────────────────────
async function sendMsg(to, text) {
  try {
    await axios.post(WA_URL, {
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, ''),
      type: 'text',
      text: { body: text }
    }, { headers: HEADERS });
  } catch (err) {
    console.error('WA send error:', err.response?.data || err.message);
  }
}

// ── Handle incoming message ────────────────────────────────────
async function handleMessage(from, text) {
  const t = text.trim().toUpperCase();

  // ── Admin commands ────────────────────────────────────────────
  if (from === ADMIN_PHONE) {
    if (t.startsWith('ADD AGENT')) {
      const match = text.match(/ADD AGENT (\d+) (.+?) ([ABC])$/i);
      if (match) {
        await db.query(`
          INSERT INTO agents (hotel_id, name, phone, category, discount_pct)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (phone) DO UPDATE SET name=$2, category=$4, discount_pct=$5
        `, [HOTEL_ID, match[2].trim(), match[1], match[3].toUpperCase(),
            match[3] === 'A' ? 10 : match[3] === 'B' ? 5 : 0]);
        await sendMsg(from, `✅ *${match[2].trim()}* (${match[1]}) added as Category ${match[3].toUpperCase()}`);
      }
      return;
    }
    if (t.startsWith('REMOVE AGENT')) {
      const match = text.match(/REMOVE AGENT (\d+)/i);
      if (match) {
        await db.query('UPDATE agents SET is_active = false WHERE phone = $1', [match[1]]);
        await sendMsg(from, `✅ Agent ${match[1]} removed`);
      }
      return;
    }
    if (t === 'LIST AGENTS') {
      const agents = await db.query(
        'SELECT name, phone, category FROM agents WHERE hotel_id = $1 AND is_active = true ORDER BY name',
        [HOTEL_ID]
      );
      const list = agents.rows.map((a, i) => `${i + 1}. *${a.name}* — ${a.phone} — Cat ${a.category}`).join('\n');
      await sendMsg(from, `📋 *Active Agents (${agents.rows.length}):*\n\n${list}`);
      return;
    }
  }

  // ── Check if agent ────────────────────────────────────────────
  const agentRes = await db.query(
    'SELECT * FROM agents WHERE phone = $1 AND is_active = true',
    [from]
  );
  const isAdmin = from === ADMIN_PHONE;
  if (!agentRes.rows[0] && !isAdmin) {
    await sendMsg(from, `Sorry, this service is for registered travel agents only. 🙏\n\nContact: +91 88948 88885`);
    return;
  }
  const agent = agentRes.rows[0] || { name: 'Admin', category: 'A', phone: from };

  // ── Session flow ──────────────────────────────────────────────
  if (!sessions[from]) sessions[from] = { step: 'idle' };
  const session = sessions[from];
  session.agentName = agent.name;
  session.agentCategory = agent.category;

  // Awaiting room type
  if (session.step === 'awaiting_room_type') {
    const l = text.toLowerCase();
    if (l.includes('honey') || t === '3') session.roomType = 'Honeymoon';
    else if (l.includes('super') || t === '2') session.roomType = 'Super Deluxe';
    else if (l.includes('deluxe') || t === '1') session.roomType = 'Deluxe';
    else { await sendMsg(from, 'Reply 1 for Deluxe, 2 for Super Deluxe, 3 for Honeymoon'); return; }
    session.step = 'idle';
    if (!session.plan) { session.step = 'awaiting_plan'; await sendMsg(from, `Please select meal plan:\n*CP* — Continental Plan\n*MAP* — Modified American Plan`); }
    else await processEnquiry(from, session);
    return;
  }

  // Awaiting plan
  if (session.step === 'awaiting_plan') {
    if (['CP','MAP'].includes(t)) { session.plan = t; await processEnquiry(from, session); }
    else await sendMsg(from, 'Please reply *CP* or *MAP*');
    return;
  }

  // Awaiting confirmation
  if (session.step === 'awaiting_confirm') {
    if (['YES','Y','CONFIRM','OK','HAAN'].includes(t)) {
      await confirmBooking(from, session);
    } else if (['NO','N','CANCEL','NAHI'].includes(t)) {
      sessions[from] = { step: 'idle' };
      await sendMsg(from, `Dear *${agent.name}*,\n\nUnderstood! Enquiry cancelled. Feel free to enquire again anytime. 🙏`);
    }
    return;
  }

  // Parse new enquiry
  const enquiry = parseEnquiry(text);
  if (!enquiry) { await sendMsg(from, helpMsg(agent.name)); return; }

  Object.assign(session, enquiry);

  if (enquiry.rooms > MAX_ROOMS) {
    await sendMsg(from, `Dear *${agent.name}*,\n\nMax ${MAX_ROOMS} rooms online. For more: 📞 +91 88948 88885`);
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);
  const ci = new Date(enquiry.ciDate);
  if (ci < today) { await sendMsg(from, `Dear *${agent.name}*, check-in date is in the past. Please send a future date.`); return; }
  if (ci < FY_START || ci > FY_END) { await sendMsg(from, `Dear *${agent.name}*, bookings accepted only for 1 Apr 2026 – 31 Mar 2027.`); return; }

  if (!enquiry.roomType) { session.step = 'awaiting_room_type'; await sendMsg(from, `Dear *${agent.name}*, select room type:\n*1* — Deluxe\n*2* — Super Deluxe\n*3* — Honeymoon`); return; }
  if (!enquiry.plan) { session.step = 'awaiting_plan'; await sendMsg(from, `Dear *${agent.name}*, select plan:\n*CP* — Continental Plan\n*MAP* — Modified American Plan`); return; }

  await processEnquiry(from, session);
}

// ── Check availability and send reply ─────────────────────────
async function processEnquiry(from, session) {
  session.step = 'pending';

  const rtRes = await db.query(
    'SELECT * FROM room_types WHERE hotel_id = $1 AND LOWER(name) = LOWER($2)',
    [HOTEL_ID, session.roomType]
  );
  if (!rtRes.rows[0]) { await sendMsg(from, 'Room type not found. Please try again.'); return; }
  const roomType = rtRes.rows[0];

  const availability = await Reservation.checkAvailability(
    HOTEL_ID, roomType.id, session.ciDate, session.coDate, session.rooms
  );

  const rateInfo = await RatesModel.getRateForAgent(
    HOTEL_ID, roomType.id, session.ciDate, session.plan, session.agentCategory
  );

  session.roomTypeId = roomType.id;
  session.rate = rateInfo?.finalRate;
  session.seasonId = rateInfo?.seasonId;
  session.season = rateInfo?.season;

  if (availability.available) {
    session.step = 'awaiting_confirm';
    const nights = Math.round((new Date(session.coDate) - new Date(session.ciDate)) / 86400000);
    await sendMsg(from,
      `Dear *${session.agentName}*,\n\n` +
      `✅ *Rooms Available!*\n\n` +
      `📅 Check-in: ${fmtDate(session.ciDate)}\n` +
      `📅 Check-out: ${fmtDate(session.coDate)}\n` +
      `🛏 ${session.roomType} × ${session.rooms} room${session.rooms > 1 ? 's' : ''}\n` +
      `🍽 Plan: ${session.plan}\n` +
      `💰 Rate: ₹${session.rate?.toLocaleString()}/room/night\n` +
      `🌙 Nights: ${nights}\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`
    );
    await sendMsg(ADMIN_PHONE,
      `📋 *Availability Sent*\nAgent: ${session.agentName} (${from}) [Cat ${session.agentCategory}]\n` +
      `${session.roomType} × ${session.rooms} | ${session.plan} | ${fmtDate(session.ciDate)} → ${fmtDate(session.coDate)}\n` +
      `Rate: ₹${session.rate} (${session.season})\nWaiting for confirmation.`
    );
  } else {
    sessions[from] = { step: 'idle' };
    await sendMsg(from,
      `Dear *${session.agentName}*,\n\n` +
      `❌ Sorry, rooms are not available for:\n` +
      `${session.roomType} | ${fmtDate(session.ciDate)} – ${fmtDate(session.coDate)}\n\n` +
      `Please try different dates. 🙏`
    );
  }
}

// ── Create booking in database ────────────────────────────────
async function confirmBooking(from, session) {
  try {
    const agentRes = await db.query('SELECT id FROM agents WHERE phone = $1', [from]);
    const reservation = await Reservation.createReservation({
      hotelId: HOTEL_ID,
      agentId: agentRes.rows[0]?.id,
      guestId: null,
      roomTypeId: session.roomTypeId,
      seasonId: session.seasonId,
      checkinDate: session.ciDate,
      checkoutDate: session.coDate,
      roomsCount: session.rooms,
      plan: session.plan,
      ratePerNight: session.rate,
      source: 'whatsapp',
    });

    sessions[from] = { step: 'idle' };

    const nights = Math.round((new Date(session.coDate) - new Date(session.ciDate)) / 86400000);
    const total = session.rate * session.rooms * nights;

    await sendMsg(from,
      `Dear *${session.agentName}*,\n\n` +
      `🎉 *Booking Confirmed!*\n\n` +
      `📋 Ref: *${reservation.reservation_no}*\n` +
      `📅 ${fmtDate(session.ciDate)} → ${fmtDate(session.coDate)}\n` +
      `🛏 ${session.roomType} × ${session.rooms} room${session.rooms > 1 ? 's' : ''}\n` +
      `🍽 Plan: ${session.plan}\n` +
      `💰 ₹${session.rate?.toLocaleString()}/night × ${nights} nights\n` +
      `💳 Total: ₹${total.toLocaleString()}\n\n` +
      `Use booking ID *${reservation.reservation_no}* to manage booking at:\n` +
      `🔗 optiosetup.in/portal\n\n` +
      `Thank you! 🙏`
    );

    await sendMsg(ADMIN_PHONE,
      `✅ *New Booking Created*\n` +
      `Ref: ${reservation.reservation_no}\n` +
      `Agent: ${session.agentName} (${from})\n` +
      `${session.roomType} × ${session.rooms} | ${session.plan}\n` +
      `${fmtDate(session.ciDate)} → ${fmtDate(session.coDate)}\n` +
      `Rate: ₹${session.rate} | Total: ₹${total.toLocaleString()}`
    );
  } catch (err) {
    console.error('Confirm booking error:', err);
    await sendMsg(from, 'Sorry, booking creation failed. Please contact admin. 🙏');
  }
}

// ── Parse enquiry text ─────────────────────────────────────────
function parseEnquiry(text) {
  const lower = text.toLowerCase();
  const keywords = ['room','check','book','need','enquir','night','stay','deluxe','honeymoon','super'];
  if (!keywords.some(k => lower.includes(k))) return null;

  const result = {};
  const roomMatch = text.match(/(\d+)\s*room/i);
  result.rooms = roomMatch ? parseInt(roomMatch[1]) : 1;

  if (/\bCP\b/i.test(text)) result.plan = 'CP';
  else if (/\bMAP\b/i.test(text)) result.plan = 'MAP';
  else result.plan = null;

  if (/honey/i.test(text)) result.roomType = 'Honeymoon';
  else if (/super/i.test(text)) result.roomType = 'Super Deluxe';
  else if (/deluxe/i.test(text)) result.roomType = 'Deluxe';
  else result.roomType = null;

  const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const dates = [];
  const re = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const day = parseInt(m[1]);
    const mon = MONTHS[m[2].toLowerCase().slice(0,3)];
    const yr = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    dates.push(`${yr}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
  }

  if (dates.length >= 2) { result.ciDate = dates[0]; result.coDate = dates[1]; }
  else if (dates.length === 1) { result.ciDate = dates[0]; result.coDate = null; }
  else return null;

  return result;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function helpMsg(name) {
  return `👋 Dear *${name}*,\n\nSend enquiry like:\n_"Need 2 Deluxe rooms, check-in 15 May, check-out 17 May, CP plan"_\n\n📅 Bookings: 1 Apr 2026 – 31 Mar 2027\nMax 5 rooms per booking. 🙏`;
}

module.exports = router;

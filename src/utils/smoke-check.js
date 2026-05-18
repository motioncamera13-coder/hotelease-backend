require('dotenv').config();
const axios = require('axios');

const baseUrl = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const hotelId = process.argv[3] || process.env.HOTEL_ID;

async function check(name, path, validate) {
  try {
    const res = await axios.get(baseUrl + path, { timeout: 15000 });
    const ok = validate ? validate(res.data) : res.status >= 200 && res.status < 300;
    return { name, ok, status: res.status, sample: summarize(res.data) };
  } catch (err) {
    return {
      name,
      ok: false,
      status: err.response?.status || 'ERR',
      error: err.response?.data?.error || err.message,
    };
  }
}

function summarize(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.data)) return { success: data.success, count: data.data.length };
  if (data.summary) return { success: data.success, summary: data.summary };
  if (data.data && typeof data.data === 'object') return { success: data.success, keys: Object.keys(data.data) };
  return Object.fromEntries(Object.entries(data).slice(0, 5));
}

async function main() {
  if (!hotelId) {
    console.error('HOTEL_ID is required. Pass it as arg 2 or set HOTEL_ID.');
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const checks = [
    check('health', '/', data => data.status?.includes('HotelEase PMS running')),
    check('rooms', `/api/rooms?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
    check('reservations', `/api/reservations?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
    check('agents', `/api/agents?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
    check('guests', `/api/guests?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
    check('daily report', `/api/reports/daily?hotelId=${hotelId}&date=${today}`, data => data.success && data.data),
    check('room types', `/api/rooms/types?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
    check('rates', `/api/rates?hotelId=${hotelId}`, data => data.success && Array.isArray(data.data)),
  ];

  const results = await Promise.all(checks);
  console.table(results.map(({ name, ok, status, error }) => ({ name, ok, status, error: error || '' })));
  console.log(JSON.stringify(results, null, 2));

  if (results.some(r => !r.ok)) process.exit(1);
}

main();

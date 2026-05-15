require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/agents',       require('./routes/agents'));
app.use('/api/rooms',        require('./routes/rooms'));
app.use('/api/guests',       require('./routes/guests'));
app.use('/api/rates',        require('./routes/rates'));
app.use('/api/reports',      require('./routes/reports'));
app.use('/api/housekeeping', require('./routes/housekeeping'));
app.use('/api/cashbook',     require('./routes/cashbook'));
app.use('/api/cforms',       require('./routes/cforms'));
app.use('/api/operations',   require('./routes/operations'));
app.use('/api/auth',         require('./routes/auth'));
app.use('/webhook',          require('./routes/webhook'));
app.use('/api/housekeeping',  require('./routes/housekeeping'));
app.use('/api/operations',    require('./routes/operations'));
app.use('/api/requisitions',  require('./routes/requisitions'));
app.use('/api/vouchers',      require('./routes/vouchers'));

// ── Health check ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'HotelEase PMS running ✓',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

// ── Cron jobs ──────────────────────────────────────────────────
// Every day at 8 AM — send check-in messages to guests
cron.schedule('0 8 * * *', async () => {
  console.log('🕗 Running check-in messages cron...');
  try {
    const { sendCheckinMessages } = require('./utils/whatsapp-scheduler');
    await sendCheckinMessages();
  } catch (err) {
    console.error('✗ Check-in cron error:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Every day at 9 AM — send check-out messages
cron.schedule('0 9 * * *', async () => {
  console.log('🕘 Running check-out messages cron...');
  try {
    const { sendCheckoutMessages } = require('./utils/whatsapp-scheduler');
    await sendCheckoutMessages();
  } catch (err) {
    console.error('✗ Check-out cron error:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Every day at 10 PM — send review requests to checkouts
cron.schedule('0 22 * * *', async () => {
  console.log('🌙 Running review request cron...');
  try {
    const { sendReviewRequests } = require('./utils/whatsapp-scheduler');
    await sendReviewRequests();
  } catch (err) {
    console.error('✗ Review cron error:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

// ── Error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HotelEase PMS running on port ${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api`);
});


const db = require('../../config/database');

// ── Get current season for a date ─────────────────────────────
async function getSeasonForDate(hotelId, date) {
  const res = await db.query(`
    SELECT * FROM seasons
    WHERE hotel_id = $1
      AND $2 BETWEEN start_date AND end_date
    LIMIT 1
  `, [hotelId, date]);
  return res.rows[0] || null;
}

// ── Get rate ───────────────────────────────────────────────────
async function getRate(hotelId, roomTypeId, seasonId, plan) {
  const res = await db.query(`
    SELECT r.*, rt.name as room_type_name, s.name as season_name
    FROM rates r
    JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN seasons s ON r.season_id = s.id
    WHERE r.hotel_id = $1
      AND r.room_type_id = $2
      AND (r.season_id = $3 OR r.season_id IS NULL)
      AND r.plan = $4
    ORDER BY r.season_id NULLS LAST
    LIMIT 1
  `, [hotelId, roomTypeId, seasonId, plan]);
  return res.rows[0] || null;
}

// ── Get rate with agent category discount ─────────────────────
async function getRateForAgent(hotelId, roomTypeId, checkinDate, plan, agentCategory = 'C') {
  const season = await getSeasonForDate(hotelId, checkinDate);
  const rate = await getRate(hotelId, roomTypeId, season?.id, plan);

  if (!rate) return null;

  // Apply category discount
  const discounts = { A: 10, B: 5, C: 0 };
  const discount = discounts[agentCategory] || 0;
  const finalRate = Math.round(rate.rate_per_night * (1 - discount / 100));

  return {
    ...rate,
    baseRate: rate.rate_per_night,
    finalRate,
    discount,
    season: season?.name || 'Regular',
    seasonId: season?.id,
  };
}

// ── Get all rates for hotel ────────────────────────────────────
async function getAllRates(hotelId) {
  const res = await db.query(`
    SELECT r.*, rt.name as room_type_name, s.name as season_name,
           s.start_date, s.end_date
    FROM rates r
    JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN seasons s ON r.season_id = s.id
    WHERE r.hotel_id = $1
    ORDER BY rt.name, s.start_date, r.plan
  `, [hotelId]);
  return res.rows;
}

// ── Seed default rates for Sukhsagar ──────────────────────────
async function seedDefaultRates(hotelId) {
  // This function creates default seasons and rates
  // Call once after hotel is created

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get room types
    const roomTypes = await client.query(
      'SELECT id, name FROM room_types WHERE hotel_id = $1', [hotelId]
    );

    // Create seasons
    const peakSeason = await client.query(`
      INSERT INTO seasons (hotel_id, name, start_date, end_date)
      VALUES ($1, 'Peak Season', '2026-04-15', '2026-06-30')
      ON CONFLICT DO NOTHING RETURNING id
    `, [hotelId]);

    const offSeason = await client.query(`
      INSERT INTO seasons (hotel_id, name, start_date, end_date)
      VALUES ($1, 'Off Season', '2026-07-01', '2026-12-20')
      ON CONFLICT DO NOTHING RETURNING id
    `, [hotelId]);

    // Rate matrix
    const rateMatrix = {
      'Deluxe':       { CP: { peak: 4100, off: 3000 }, MAP: { peak: 4900, off: 3600 } },
      'Super Deluxe': { CP: { peak: 4600, off: 3500 }, MAP: { peak: 5400, off: 4100 } },
      'Honeymoon':    { CP: { peak: 5100, off: 4000 }, MAP: { peak: 5900, off: 4600 } },
    };

    for (const rt of roomTypes.rows) {
      const matrix = rateMatrix[rt.name];
      if (!matrix) continue;

      for (const [plan, seasons] of Object.entries(matrix)) {
        if (peakSeason.rows[0]) {
          await client.query(`
            INSERT INTO rates (hotel_id, room_type_id, season_id, plan, rate_per_night)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
          `, [hotelId, rt.id, peakSeason.rows[0].id, plan, seasons.peak]);
        }
        if (offSeason.rows[0]) {
          await client.query(`
            INSERT INTO rates (hotel_id, room_type_id, season_id, plan, rate_per_night)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
          `, [hotelId, rt.id, offSeason.rows[0].id, plan, seasons.off]);
        }
      }
    }

    await client.query('COMMIT');
    console.log('✓ Default rates seeded');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getSeasonForDate, getRate, getRateForAgent, getAllRates, seedDefaultRates };

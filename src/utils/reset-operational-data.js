require('dotenv').config();
const db = require('../config/database');

const hotelId = process.argv[2] || null;
const confirm = process.env.CONFIRM_RESET === 'YES_DELETE_OPERATIONAL_DATA';

const tablesToClear = [
  'requisition_items',
  'requisition_slips',
  'vouchers',
  'folio',
  'c_forms',
  'room_swaps',
  'cash_book',
  'bills',
  'payments',
  'extra_charges',
  'reservation_rooms',
  'reservations',
  'whatsapp_sessions',
  'activity_log',
  'guests',
  'agents',
];

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return result.rows[0]?.exists === true;
}

async function clearTable(client, tableName) {
  if (!(await tableExists(client, tableName))) {
    return { table: tableName, skipped: true, reason: 'missing' };
  }

  if (hotelId) {
    if (tableName === 'reservation_rooms') {
      const result = await client.query(`
        DELETE FROM reservation_rooms rr
        USING reservations r
        WHERE rr.reservation_id = r.id AND r.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    if (['bills', 'payments', 'extra_charges'].includes(tableName)) {
      const result = await client.query(`
        DELETE FROM ${tableName} t
        USING reservations r
        WHERE t.reservation_id = r.id AND r.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    if (tableName === 'requisition_items') {
      const result = await client.query(`
        DELETE FROM requisition_items ri
        USING requisition_slips rs
        WHERE ri.requisition_id = rs.id AND rs.hotel_id = $1
      `, [hotelId]);
      return { table: tableName, deleted: result.rowCount };
    }

    const result = await client.query(`DELETE FROM ${tableName} WHERE hotel_id = $1`, [hotelId]);
    return { table: tableName, deleted: result.rowCount };
  }

  const result = await client.query(`DELETE FROM ${tableName}`);
  return { table: tableName, deleted: result.rowCount };
}

async function resetHousekeeping(client) {
  if (!(await tableExists(client, 'housekeeping'))) return { skipped: true, reason: 'missing' };
  const result = hotelId
    ? await client.query('DELETE FROM housekeeping WHERE hotel_id=$1', [hotelId])
    : await client.query('DELETE FROM housekeeping');
  return { deleted: result.rowCount };
}

async function resetRooms(client) {
  const result = hotelId
    ? await client.query(`UPDATE rooms SET status='available' WHERE hotel_id=$1`, [hotelId])
    : await client.query(`UPDATE rooms SET status='available'`);
  return { updated: result.rowCount };
}

async function summarize(client) {
  const summary = {};
  for (const table of ['hotels', 'users', 'rooms', 'room_types', 'rates', 'reservations', 'guests', 'agents']) {
    if (!(await tableExists(client, table))) continue;
    const result = hotelId && ['rooms', 'room_types', 'rates', 'reservations', 'guests', 'agents'].includes(table)
      ? await client.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE hotel_id=$1`, [hotelId])
      : await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    summary[table] = result.rows[0].count;
  }
  return summary;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  if (!confirm) {
    console.log('Refusing to reset data without confirmation.');
    console.log('Run with: CONFIRM_RESET=YES_DELETE_OPERATIONAL_DATA node src/utils/reset-operational-data.js');
    console.log('Optional single hotel: node src/utils/reset-operational-data.js <hotel_uuid>');
    process.exit(1);
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const before = await summarize(client);
    const deleted = [];
    for (const table of tablesToClear) {
      deleted.push(await clearTable(client, table));
    }
    const housekeeping = await resetHousekeeping(client);
    const rooms = await resetRooms(client);
    const after = await summarize(client);

    await client.query('COMMIT');
    console.log(JSON.stringify({ hotelId: hotelId || 'all', before, deleted, housekeeping, rooms, after }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});

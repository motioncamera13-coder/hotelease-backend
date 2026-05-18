-- ═══════════════════════════════════════════════════════════
-- HotelEase PMS — Complete Database Schema
-- ═══════════════════════════════════════════════════════════

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Hotels ───────────────────────────────────────────────────
CREATE TABLE hotels (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(200) NOT NULL,
  address       TEXT,
  city          VARCHAR(100),
  state         VARCHAR(100),
  phone         VARCHAR(20),
  email         VARCHAR(100),
  gstin         VARCHAR(20),
  whatsapp_bot_number VARCHAR(20),
  admin_phone   VARCHAR(20),
  total_rooms   INT DEFAULT 0,
  buffer_rooms  INT DEFAULT 4,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Room types ────────────────────────────────────────────────
CREATE TABLE room_types (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,  -- Deluxe, Super Deluxe, Honeymoon
  description   TEXT,
  capacity      INT DEFAULT 2,
  extra_bed     BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Rooms ─────────────────────────────────────────────────────
CREATE TABLE rooms (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id  UUID REFERENCES room_types(id),
  room_number   VARCHAR(10) NOT NULL,
  floor         INT DEFAULT 1,
  status        VARCHAR(20) DEFAULT 'available', -- available, occupied, maintenance, housekeeping
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(hotel_id, room_number)
);

-- ── Seasons ───────────────────────────────────────────────────
CREATE TABLE seasons (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name          VARCHAR(50) NOT NULL,  -- Peak, Off Season
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Rates ─────────────────────────────────────────────────────
CREATE TABLE rates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id  UUID REFERENCES room_types(id),
  season_id     UUID REFERENCES seasons(id),
  plan          VARCHAR(10) NOT NULL,   -- CP, MAP, EP
  rate_per_night DECIMAL(10,2) NOT NULL,
  extra_bed_charge DECIMAL(10,2) DEFAULT 800,
  extra_breakfast_charge DECIMAL(10,2) DEFAULT 400,
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_type_id, season_id, plan)
);

-- ── Agents ────────────────────────────────────────────────────
CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  phone         VARCHAR(20) UNIQUE NOT NULL,
  email         VARCHAR(100),
  category      CHAR(1) DEFAULT 'C',   -- A, B, C
  discount_pct  DECIMAL(5,2) DEFAULT 0,
  company       VARCHAR(200),
  is_active     BOOLEAN DEFAULT true,
  added_at      TIMESTAMP DEFAULT NOW()
);

-- ── Guests ────────────────────────────────────────────────────
CREATE TABLE guests (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  phone         VARCHAR(20),
  email         VARCHAR(100),
  id_type       VARCHAR(30),            -- Aadhar, PAN, Passport
  id_number     VARCHAR(50),
  address       TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Reservations ──────────────────────────────────────────────
CREATE TABLE reservations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  reservation_no  VARCHAR(30) UNIQUE NOT NULL, -- HE20260515001
  agent_id        UUID REFERENCES agents(id),
  guest_id        UUID REFERENCES guests(id),
  room_type_id    UUID REFERENCES room_types(id),
  season_id       UUID REFERENCES seasons(id),
  checkin_date    DATE NOT NULL,
  checkout_date   DATE NOT NULL,
  nights          INT GENERATED ALWAYS AS (checkout_date - checkin_date) STORED,
  rooms_count     INT DEFAULT 1,
  plan            VARCHAR(10) NOT NULL,  -- CP, MAP, EP
  rate_per_night  DECIMAL(10,2) NOT NULL,
  status          VARCHAR(20) DEFAULT 'confirmed', -- confirmed, checked_in, checked_out, cancelled
  source          VARCHAR(20) DEFAULT 'whatsapp',  -- whatsapp, walk_in, phone, online
  special_requests TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ── Reservation rooms (which specific rooms assigned) ─────────
CREATE TABLE reservation_rooms (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  room_id         UUID REFERENCES rooms(id),
  assigned_at     TIMESTAMP DEFAULT NOW()
);

-- ── Extra charges ─────────────────────────────────────────────
CREATE TABLE extra_charges (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  charge_type     VARCHAR(50) NOT NULL,  -- extra_bed, extra_breakfast, add_rooms, food, laundry
  description     TEXT,
  quantity        INT DEFAULT 1,
  nights          INT DEFAULT 1,
  rate            DECIMAL(10,2) NOT NULL,
  total           DECIMAL(10,2) GENERATED ALWAYS AS (quantity * nights * rate) STORED,
  is_free         BOOLEAN DEFAULT false,  -- for child no bed
  person_age      INT,                    -- for age-based charging
  added_at        TIMESTAMP DEFAULT NOW(),
  added_by        VARCHAR(50) DEFAULT 'agent'  -- agent, staff, system
);

-- ── Payments ──────────────────────────────────────────────────
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  amount          DECIMAL(10,2) NOT NULL,
  payment_mode    VARCHAR(30),   -- cash, upi, card, bank_transfer
  payment_date    TIMESTAMP DEFAULT NOW(),
  reference_no    VARCHAR(100),
  notes           TEXT,
  added_by        VARCHAR(50)
);

-- ── Bills ─────────────────────────────────────────────────────
CREATE TABLE bills (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id  UUID UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  bill_no         VARCHAR(30) UNIQUE NOT NULL,
  room_charges    DECIMAL(10,2) DEFAULT 0,
  extra_charges   DECIMAL(10,2) DEFAULT 0,
  subtotal        DECIMAL(10,2) DEFAULT 0,
  gst_rate        DECIMAL(5,2) DEFAULT 12,
  gst_amount      DECIMAL(10,2) DEFAULT 0,
  total           DECIMAL(10,2) DEFAULT 0,
  paid_amount     DECIMAL(10,2) DEFAULT 0,
  balance         DECIMAL(10,2) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending',  -- pending, paid, partial
  generated_at    TIMESTAMP DEFAULT NOW()
);

-- ── WhatsApp sessions ──────────────────────────────────────────
CREATE TABLE whatsapp_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  phone           VARCHAR(20) NOT NULL,
  session_data    JSONB DEFAULT '{}',
  step            VARCHAR(50) DEFAULT 'idle',
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(hotel_id, phone)
);

-- ── Activity log ──────────────────────────────────────────────
CREATE TABLE activity_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  action          VARCHAR(100) NOT NULL,
  entity_type     VARCHAR(50),   -- reservation, guest, agent, room
  entity_id       UUID,
  details         JSONB DEFAULT '{}',
  performed_by    VARCHAR(100),
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_reservations_hotel     ON reservations(hotel_id);
CREATE INDEX idx_reservations_checkin   ON reservations(checkin_date);
CREATE INDEX idx_reservations_checkout  ON reservations(checkout_date);
CREATE INDEX idx_reservations_status    ON reservations(status);
CREATE INDEX idx_reservations_agent     ON reservations(agent_id);
CREATE INDEX idx_rooms_hotel            ON rooms(hotel_id);
CREATE INDEX idx_rooms_status           ON rooms(status);
CREATE INDEX idx_agents_phone           ON agents(phone);
CREATE INDEX idx_guests_phone           ON guests(phone);
CREATE INDEX idx_extra_charges_res      ON extra_charges(reservation_id);
CREATE INDEX idx_payments_res           ON payments(reservation_id);
CREATE INDEX idx_wa_sessions_phone      ON whatsapp_sessions(phone);

-- ── Seed: Sukh Sagar Regency hotel ───────────────────────────
INSERT INTO hotels (name, city, state, phone, gstin, admin_phone, total_rooms, buffer_rooms)
VALUES ('Hotel Sukhsagar Regency', 'Shimla', 'Himachal Pradesh',
        '9816003322', 'YOUR_GSTIN', '919816003322', 50, 4)
ON CONFLICT DO NOTHING;

-- ── Users (multi-hotel auth) ──────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id      UUID REFERENCES hotels(id) ON DELETE CASCADE,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(200) NOT NULL,
  role          VARCHAR(30) DEFAULT 'hotel_staff',
  -- Roles: super_admin, hotel_admin, hotel_staff, restaurant_staff
  email         VARCHAR(100),
  is_active     BOOLEAN DEFAULT true,
  last_login    TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_hotel    ON users(hotel_id);

-- ── Role permissions ──────────────────────────────────────────
CREATE TABLE role_permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id    UUID REFERENCES hotels(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL,
  pages       JSONB NOT NULL DEFAULT '[]',
  permissions JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(hotel_id, role)
);

-- ── Super admin (no hotel_id) ──────────────────────────────────
-- INSERT INTO users (username, password_hash, name, role)
-- VALUES ('superadmin', '<bcrypt_hash>', 'Super Admin', 'super_admin');
-- Run: node src/utils/create-super-admin.js to create it

-- ── Housekeeping ──────────────────────────────────────────────
CREATE TABLE housekeeping (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  room_id         UUID REFERENCES rooms(id) ON DELETE CASCADE,
  status          VARCHAR(30) DEFAULT 'dirty',
  -- Status: dirty, cleaning, clean, inspected, out_of_order
  assigned_to     VARCHAR(100),
  priority        VARCHAR(10) DEFAULT 'normal', -- high, normal, low
  notes           TEXT,
  cleaned_at      TIMESTAMP,
  inspected_at    TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT NOW(),
  date            DATE DEFAULT CURRENT_DATE
);

-- ── Cash book ─────────────────────────────────────────────────
CREATE TABLE cash_book (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  type            VARCHAR(10) NOT NULL,  -- in, out
  amount          DECIMAL(10,2) NOT NULL,
  category        VARCHAR(50),
  -- Categories: room_payment, advance, refund, expense, salary, purchase, misc
  description     TEXT NOT NULL,
  reference_no    VARCHAR(100),
  reservation_id  UUID REFERENCES reservations(id),
  payment_mode    VARCHAR(20) DEFAULT 'cash', -- cash, upi, card, bank
  added_by        VARCHAR(100),
  transaction_at  TIMESTAMP DEFAULT NOW(),
  date            DATE DEFAULT CURRENT_DATE
);

-- ── C-Form (Guest registration for police) ────────────────────
CREATE TABLE c_forms (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id        UUID REFERENCES guests(id),
  form_no         VARCHAR(30) UNIQUE,
  guest_name      VARCHAR(200) NOT NULL,
  guest_phone     VARCHAR(20),
  nationality     VARCHAR(50) DEFAULT 'Indian',
  id_type         VARCHAR(30), -- Aadhar, PAN, Passport, DL, VoterID
  id_number       VARCHAR(50),
  dob             DATE,
  gender          VARCHAR(10),
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(100),
  purpose_of_visit VARCHAR(100) DEFAULT 'Tourism',
  arrival_from    VARCHAR(100),
  proceeding_to   VARCHAR(100),
  checkin_date    DATE,
  checkout_date   DATE,
  room_number     VARCHAR(10),
  submitted       BOOLEAN DEFAULT false,
  submitted_at    TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── Room swaps ────────────────────────────────────────────────
CREATE TABLE room_swaps (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  reservation_id  UUID REFERENCES reservations(id),
  from_room_id    UUID REFERENCES rooms(id),
  to_room_id      UUID REFERENCES rooms(id),
  reason          TEXT,
  swapped_by      VARCHAR(100),
  swapped_at      TIMESTAMP DEFAULT NOW()
);

-- ── Folio (running guest account) ────────────────────────────
CREATE TABLE folio (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  type            VARCHAR(10) NOT NULL, -- debit, credit
  description     TEXT NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  category        VARCHAR(30),
  -- debit: room_charge, extra_bed, breakfast, restaurant, laundry, misc
  -- credit: advance, payment, discount
  added_at        TIMESTAMP DEFAULT NOW(),
  added_by        VARCHAR(100)
);

CREATE INDEX idx_housekeeping_hotel ON housekeeping(hotel_id);
CREATE INDEX idx_housekeeping_date  ON housekeeping(date);
CREATE INDEX idx_cashbook_hotel     ON cash_book(hotel_id);
CREATE INDEX idx_cashbook_date      ON cash_book(date);
CREATE INDEX idx_cform_hotel        ON c_forms(hotel_id);
CREATE INDEX idx_folio_res          ON folio(reservation_id);

-- ── Requisition slips ─────────────────────────────────────────
CREATE TABLE requisition_slips (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  slip_no         VARCHAR(30) UNIQUE NOT NULL,
  department      VARCHAR(50) NOT NULL,
  -- Housekeeping, Kitchen, Front Desk, Maintenance, Restaurant
  requested_by    VARCHAR(100) NOT NULL,
  approved_by     VARCHAR(100),
  status          VARCHAR(20) DEFAULT 'pending',
  -- pending, approved, issued, rejected
  priority        VARCHAR(10) DEFAULT 'normal',
  notes           TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  approved_at     TIMESTAMP,
  issued_at       TIMESTAMP
);

CREATE TABLE requisition_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requisition_id  UUID REFERENCES requisition_slips(id) ON DELETE CASCADE,
  item_name       VARCHAR(200) NOT NULL,
  quantity        DECIMAL(10,2) NOT NULL,
  unit            VARCHAR(20),
  -- pieces, kg, litre, box, packet, roll
  estimated_cost  DECIMAL(10,2),
  issued_qty      DECIMAL(10,2),
  notes           TEXT
);

-- ── Vouchers ──────────────────────────────────────────────────
CREATE TABLE vouchers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        UUID REFERENCES hotels(id) ON DELETE CASCADE,
  voucher_no      VARCHAR(30) UNIQUE NOT NULL,
  voucher_type    VARCHAR(30) NOT NULL,
  -- payment, receipt, journal, contra, purchase, expense
  date            DATE DEFAULT CURRENT_DATE,
  party_name      VARCHAR(200),
  description     TEXT NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  payment_mode    VARCHAR(20),
  -- cash, upi, bank, cheque
  cheque_no       VARCHAR(50),
  bank_name       VARCHAR(100),
  reference_no    VARCHAR(100),
  reservation_id  UUID REFERENCES reservations(id),
  approved_by     VARCHAR(100),
  status          VARCHAR(20) DEFAULT 'draft',
  -- draft, approved, posted
  created_by      VARCHAR(100),
  created_at      TIMESTAMP DEFAULT NOW(),
  approved_at     TIMESTAMP
);

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX idx_req_hotel   ON requisition_slips(hotel_id);
CREATE INDEX idx_req_status  ON requisition_slips(status);
CREATE INDEX idx_req_dept    ON requisition_slips(department);
CREATE INDEX idx_vouch_hotel ON vouchers(hotel_id);
CREATE INDEX idx_vouch_date  ON vouchers(date);
CREATE INDEX idx_vouch_type  ON vouchers(voucher_type);

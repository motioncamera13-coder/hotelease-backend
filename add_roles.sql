-- Add new roles to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_level VARCHAR(20) DEFAULT 'staff';

-- Update existing roles
UPDATE users SET role_level = 'super_admin' WHERE role = 'super_admin';
UPDATE users SET role_level = 'hotel_owner' WHERE role = 'hotel_owner';
UPDATE users SET role_level = 'hotel_admin' WHERE role = 'hotel_admin';
UPDATE users SET role_level = 'staff' WHERE role = 'staff';

-- Add new staff users for Sukhsagar
INSERT INTO users (id, username, password_hash, name, role, hotel_id, created_at)
VALUES 
  (gen_random_uuid(), 'sukhsagar_owner', '$2b$10$X9.placeholder', 'Sukhsagar Owner', 'hotel_owner', '017aa4d1-0fa7-447c-a4c9-57f590c335b2', NOW()),
  (gen_random_uuid(), 'sukhsagar_staff', '$2b$10$X9.placeholder', 'Sukhsagar Front Desk', 'staff', '017aa4d1-0fa7-447c-a4c9-57f590c335b2', NOW()),
  (gen_random_uuid(), 'sukhsagar_hk', '$2b$10$X9.placeholder', 'Sukhsagar Housekeeping', 'housekeeping', '017aa4d1-0fa7-447c-a4c9-57f590c335b2', NOW()),
  (gen_random_uuid(), 'hiddencreek_owner', '$2b$10$X9.placeholder', 'Hidden Creek Owner', 'hotel_owner', '45421ea0-4a88-482f-bb96-6edb7aef0371', NOW()),
  (gen_random_uuid(), 'hiddencreek_staff', '$2b$10$X9.placeholder', 'Hidden Creek Front Desk', 'staff', '45421ea0-4a88-482f-bb96-6edb7aef0371', NOW())
ON CONFLICT (username) DO NOTHING;

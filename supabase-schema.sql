-- Supabase SQL Schema for Busywud
-- Run this in Supabase Dashboard -> SQL Editor. Safe to run more than once.

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'busy-board',
  badge TEXT,
  price INTEGER NOT NULL,
  old_price INTEGER,
  stock INTEGER DEFAULT 0,
  image TEXT,
  product_images TEXT[] DEFAULT '{}',
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  payment_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'CREATED',
  customer JSONB,
  items JSONB,
  shipment JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  image TEXT,
  description TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE OR REPLACE FUNCTION set_category_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = TIMEZONE('utc'::text, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_category_updated_at();

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read categories" ON categories;
CREATE POLICY "Allow public read categories" ON categories FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow admin insert categories" ON categories;
CREATE POLICY "Allow admin insert categories" ON categories FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin update categories" ON categories;
CREATE POLICY "Allow admin update categories" ON categories FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow admin delete categories" ON categories;
CREATE POLICY "Allow admin delete categories" ON categories FOR DELETE USING (true);

CREATE INDEX IF NOT EXISTS idx_categories_display_order ON categories(display_order);

-- ============================================================
-- Keep updated_at honest
-- The columns above only get a value on INSERT, so an UPDATE left
-- updated_at stale and the admin list could not sort by last change.
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = TIMEZONE('utc'::text, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders USING GIN (customer);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);

-- ============================================================
-- Row Level Security
--
-- The policies below grant the anon key the access server.js needs.
-- The server holds the anon key, not the browser, so the key is not
-- exposed to customers.
--
-- They are still permissive, so anyone who obtains the anon key could
-- read every order. server.js therefore requires an admin session on
-- every admin endpoint as the real access control.
--
-- To harden the database itself as well:
--   1. Add a SUPABASE_SERVICE_ROLE_KEY to the server env.
--   2. Create a second Supabase client with that key.
--   3. Replace the admin policies below with USING (false) and switch
--      the admin queries to the service role client.
-- Leave the public INSERT policies alone: checkout needs them.
-- ============================================================

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Policies are dropped first so this script can be re-run without
-- hitting "policy already exists".

-- Products: public read for the storefront, server-side writes for admin.
DROP POLICY IF EXISTS "Allow public read products" ON products;
CREATE POLICY "Allow public read products" ON products FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow admin insert products" ON products;
CREATE POLICY "Allow admin insert products" ON products FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin update products" ON products;
CREATE POLICY "Allow admin update products" ON products FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow admin delete products" ON products;
CREATE POLICY "Allow admin delete products" ON products FOR DELETE USING (true);

-- Orders: checkout inserts, verification and the admin panel read/update.
DROP POLICY IF EXISTS "Allow public create orders" ON orders;
CREATE POLICY "Allow public create orders" ON orders FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin read orders" ON orders;
CREATE POLICY "Allow admin read orders" ON orders FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow admin update orders" ON orders;
CREATE POLICY "Allow admin update orders" ON orders FOR UPDATE USING (true);

-- Needed by the health probe and checkout test, which insert a row then
-- delete it. Without this the delete silently matched nothing and test
-- rows accumulated in the table.
DROP POLICY IF EXISTS "Allow admin delete orders" ON orders;
CREATE POLICY "Allow admin delete orders" ON orders FOR DELETE USING (true);

-- Contacts: public submit, admin read.
DROP POLICY IF EXISTS "Allow public create contacts" ON contacts;
CREATE POLICY "Allow public create contacts" ON contacts FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin read contacts" ON contacts;
CREATE POLICY "Allow admin read contacts" ON contacts FOR SELECT USING (true);

-- ============================================================
-- Verify
-- Expect three rows. If a table is missing the row will not appear,
-- which is the symptom behind "failed to create order".
-- ============================================================

SELECT 'products' AS table_name, COUNT(*) AS row_count FROM products
UNION ALL
SELECT 'orders', COUNT(*) FROM orders
UNION ALL
SELECT 'contacts', COUNT(*) FROM contacts;
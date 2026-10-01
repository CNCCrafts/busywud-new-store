-- Supabase SQL Schema for Busywud
-- Run this in Supabase Dashboard -> SQL Editor

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'busy-board',
  badge TEXT,
  price INTEGER NOT NULL,
  old_price INTEGER,
  stock INTEGER DEFAULT 0,
  image TEXT,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Orders table
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

-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders USING GIN ((customer->>'email'));
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);

-- Row Level Security (RLS) policies
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Products: allow public read, admin write
CREATE POLICY "Allow public read products" ON products FOR SELECT USING (true);
CREATE POLICY "Allow admin insert products" ON products FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow admin update products" ON products FOR UPDATE USING (true);
CREATE POLICY "Allow admin delete products" ON products FOR DELETE USING (true);

-- Orders: allow public insert, admin read/update
CREATE POLICY "Allow public create orders" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow admin read orders" ON orders FOR SELECT USING (true);
CREATE POLICY "Allow admin update orders" ON orders FOR UPDATE USING (true);

-- Contacts: allow public insert, admin read
CREATE POLICY "Allow public create contacts" ON contacts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow admin read contacts" ON contacts FOR SELECT USING (true);

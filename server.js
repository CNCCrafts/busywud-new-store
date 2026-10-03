const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_KEY_SECRET
});

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://eoyxykhbzyybjxjyfrts.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_Ro25YZ2xWpUsm7t33mfRAA_0uWOS0Rm'
);

const app = express();
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
}
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'busywud-admin-secret',
  resave: false,
  saveUninitialized: false,
  name: 'connect.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session.adminLoggedIn) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

let razorpay = null;
function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
  if (!razorpay) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }
  return razorpay;
}

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_CONFIGURED = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  const smtpHost = process.env.SMTP_HOST || 'smtp.zoho.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

async function sendOrderConfirmationEmail(order) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: '"Busywud Store" <' + (process.env.EMAIL_USER || 'busywud@gmail.com') + '>',
      to: order.customer?.email || 'customer@busywud.com',
      subject: 'Order Confirmation - Busywud',
      html: `
        <h2>Thank you for your order!</h2>
        <p>Hi ${order.customer?.name || 'Customer'},</p>
        <p>Your order has been placed successfully.</p>
        <p><strong>Order ID:</strong> ${order.orderId}</p>
        <p><strong>Amount:</strong> â‚¹${order.amount}</p>
        <p><strong>Status:</strong> ${order.status}</p>
        ${order.shipment?.waybill ? `<p><strong>Tracking:</strong> <a href="${order.shipment.trackingUrl || '#'}">${order.shipment.waybill}</a></p>` : ''}
        <p>We'll notify you once it ships.</p>
        <p>Thanks,<br>Busywud Team</p>
      `
    });
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}

async function createParcelGuruShipment(orderData) {
  try {
    const payload = {
      api_key: process.env.PARCELGURU_API_KEY,
      order_id: orderData.orderId,
      consignee_name: orderData.customer?.name || "Valued Parent",
      consignee_phone: orderData.customer?.phone || "9999999999",
      consignee_email: orderData.customer?.email || "customer@busywud.com",
      consignee_address: orderData.customer?.address || "Customer Provided Address",
      consignee_pincode: orderData.customer?.pincode || "411001",
      payment_type: "Prepaid",
      declared_value: orderData.amount,
      weight_kg: 0.8,
      product_description: "Busywud GlowLogic Wooden Board"
    };

    const response = await fetch("https://api.parcelguru.com/api/v1/shipments/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.PARCELGURU_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    return {
      waybill: result.waybill || result.awb_code || `PG-${Date.now()}`,
      shipmentId: result.shipment_id || result.id || "",
      status: result.status || "MANIFEST_GENERATED",
      trackingUrl: result.tracking_url || `https://parcelguru.com/track/${result.waybill || ""}`
    };
  } catch (error) {
    console.error("ParcelGuru Error:", error.message);
    return {
      waybill: `PG-OFFLINE-${Date.now()}`,
      shipmentId: "",
      status: "PENDING_MANUAL_DISPATCH"
    };
  }
}

async function seedDefaultProduct() {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id', { count: 'exact' });
    
    if (error) throw error;
    
    const count = data?.length || 0;
    if (count === 0) {
      const { error } = await supabase.from('products').insert({
        title: "GlowLogic Busy Board",
        category: "busy-board",
        badge: "Ages 1 to 4 Years",
        price: 1499,
        old_price: 2499,
        stock: 50,
        image: "https://res.cloudinary.com/epwhlldb/image/upload/f_auto,q_auto/v1788360758/glowlogic_busy_board.webp",
        description: "Crafted from 100% natural, non-toxic wood with smooth rounded edges."
      });
      
      if (error) throw error;
      console.log('Seeded GlowLogic Product into Database');
    }
  } catch (err) {
    console.error('Seeding error:', err.message);
  }
}

// Customer order history by email
app.get('/api/my-orders', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('customer->>email', email)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer profile update
app.put('/api/my-account', async (req, res) => {
  try {
    const { email, name, phone, address, pincode } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    
    const { data, error } = await supabase
      .from('orders')
      .update({
        customer: {
          name,
          email,
          phone,
          address,
          pincode
        }
      })
      .eq('customer->>email', email)
      .select();
    
    if (error) throw error;
    res.json({ success: true, customer: data?.[0]?.customer || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: update order status / shipment status
app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { status, triggerShipment } = req.body;
    const updateData = {};
    if (status) updateData.status = status;
    
    if (triggerShipment) {
      const { data: orderData } = await supabase
        .from('orders')
        .select('*')
        .eq('id', req.params.id)
        .single();
      
      if (orderData) {
        const shipmentDetails = await createParcelGuruShipment(orderData);
        updateData.shipment = shipmentDetails;
        if (status) updateData.status = status;
      }
    }
    
    const { data, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', req.params.id)
      .select();
    
    if (error) throw error;
    res.json(data?.[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const os = require('os');

app.get('/api/debug/checkout-test', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert({
        order_id: 'test_' + Date.now(),
        amount: 100,
        status: "TEST",
        customer: { name: "Test User", email: "test@example.com" },
        items: []
      })
      .select()
      .single();
    
    if (error) throw error;
    
    await supabase
      .from('orders')
      .delete()
      .eq('id', data.id);
    
    res.json({ success: true, message: 'Checkout simulation passed', orderId: data.id });
  } catch (err) {
    console.error('Checkout test error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }

    let dbReadTest = 'not_tested';
    try {
      const { error } = await supabase
        .from('products')
        .select('id', { count: 'exact', head: true });
      dbReadTest = error ? 'read_failed: ' + error.message : 'read_ok';
    } catch (err) {
      dbReadTest = 'read_failed: ' + err.message;
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      serverIps: ips,
      database: 'supabase',
      databaseRead: dbReadTest,
      razorpayKey: process.env.RAZORPAY_KEY_ID
        ? (process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'configured_test_mode' : 'configured_live')
        : 'missing',
      razorpayAuth: razorpayAuthState,
      razorpayWebhook: process.env.RAZORPAY_WEBHOOK_SECRET ? 'configured' : 'missing',
      writeCheck: 'use /api/health/deep'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/health/deep', async (req, res) => {
  try {
    let dbWriteTest = 'not_tested';
    try {
      const { data, error } = await supabase
        .from('orders')
        .insert({
          order_id: 'health_test_' + Date.now(),
          amount: 1,
          status: "TEST",
          customer: { name: "Test", email: "test@test.com" },
          items: []
        })
        .select()
        .single();

      if (error) throw error;
      dbWriteTest = 'write_ok';

      await supabase
        .from('orders')
        .delete()
        .eq('id', data.id);
    } catch (err) {
      dbWriteTest = 'write_failed: ' + err.message;
    }

    res.json({
      status: dbWriteTest === 'write_ok' ? 'ok' : 'degraded',
      databaseWrite: dbWriteTest
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/product', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .limit(1)
      .single();
    
    if (error || !data) {
      const defaultProduct = {
        title: "GlowLogic Busy Board",
        category: "busy-board",
        badge: "Ages 1 to 4 Years",
        price: 1499,
        oldPrice: 2499,
        stock: 50,
        image: "https://res.cloudinary.com/epwhlldb/image/upload/f_auto,q_auto/v1788360758/glowlogic_busy_board.webp",
        description: "Crafted from 100% natural, non-toxic wood with smooth rounded edges."
      };
      
      await supabase.from('products').insert(defaultProduct);
      return res.json(defaultProduct);
    }
    
    res.json(data);
  } catch (err) {
    console.error('Product fetch error:', err);
    res.status(500).json({ 
      error: 'Database temporarily unavailable. Please try again later.',
      fallback: {
        title: "GlowLogic Busy Board",
        category: "busy-board",
        badge: "Ages 1 to 4 Years",
        price: 1499,
        oldPrice: 2499,
        stock: 50,
        image: "https://res.cloudinary.com/epwhlldb/image/upload/f_auto,q_auto/v1788360758/glowlogic_busy_board.webp",
        description: "Crafted from 100% natural, non-toxic wood with smooth rounded edges."
      }
    });
  }
});

app.get('/api/video', (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const publicId = process.env.CLOUDINARY_VIDEO_PUBLIC_ID || 'generate_a_video';
  
  if (!cloudName) {
    return res.status(500).json({ error: 'Cloudinary not configured' });
  }
  
  const videoUrl = `https://res.cloudinary.com/${cloudName}/video/upload/v1788360996/${publicId}.mp4`;
  
  res.json({ url: videoUrl, publicId: publicId });
});

app.put('/api/product', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .upsert(req.body)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_CONFIGURED) {
    return res.status(503).json({ success: false, message: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env' });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.adminLoggedIn = true;
    return req.session.save(err => {
      if (err) return res.status(500).json({ success: false, message: 'Could not start session' });
      res.json({ success: true });
    });
  }

  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ loggedIn: !!req.session.adminLoggedIn });
});

// The Supabase policies are permissive by necessity (the server holds the
// anon key), so the admin session is the actual access control on these
// routes. Without it /api/orders hands every customer's name, email, phone
// and address to anyone who requests it.
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminLoggedIn) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

app.get('/api/products', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .insert(req.body)
      .select()
      .single();
    
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', req.params.id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay rejects bad credentials with a 401 and a generic description.
// Retrying those only wastes time, so classify before deciding to retry.
function classifyRazorpayError(err) {
  const status = err?.statusCode || err?.status;
  const description = err?.description || err?.error?.description || err?.message || 'unknown error';
  const authFailed = status === 401 || status === 403 || /auth/i.test(description);
  return {
    status,
    description,
    authFailed,
    retryable: !authFailed && (!status || status === 429 || status >= 500)
  };
}

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, customer, items, currency = "INR" } = req.body || {};

    const amountInRupees = Number(amount);
    if (!Number.isFinite(amountInRupees) || amountInRupees <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const options = {
      amount: Math.round(amountInRupees * 100),
      currency,
      receipt: `rcpt_${Date.now()}`
    };

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        error: 'Payments are not configured on this server. Please contact support.'
      });
    }

    let order;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        order = await getRazorpay().orders.create(options);
        break;
      } catch (err) {
        const info = classifyRazorpayError(err);
        lastError = info;
        console.error(`Razorpay order attempt ${attempt} failed (HTTP ${info.status}): ${info.description}`);

        if (info.authFailed) {
          return res.status(502).json({
            error: 'Payment gateway credentials are invalid. Please contact support.',
            gatewayReason: info.description
          });
        }
        if (!info.retryable || attempt === 2) break;
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (!order) {
      return res.status(502).json({
        error: 'Could not start the payment. Please try again.',
        gatewayReason: lastError?.description
      });
    }

    // Persist the pending order, but never block the customer on a DB hiccup:
    // the webhook reconciles the order later if this write is lost.
    let dbOrderId = null;
    try {
      const { data, error } = await supabase
        .from('orders')
        .insert({
          order_id: order.id,
          amount: amountInRupees,
          currency: currency,
          status: "CREATED",
          customer: customer || { name: "Guest Parent", email: "parent@busywud.com" },
          items: items || []
        })
        .select()
        .single();

      if (error) throw error;
      dbOrderId = data.id;
    } catch (dbErr) {
      console.error('Order persist failed (payment can still proceed):', dbErr.message);
    }

    res.json({ ...order, dbOrderId, dbOrderSaved: Boolean(dbOrderId) });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to start payment. Please try again.' });
  }
});

function safeSignatureMatch(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

// Shipping and email must never decide whether a captured payment is a success.
function fulfilOrderInBackground(order) {
  if (!order) return;
  setImmediate(async () => {
    try {
      const shipmentDetails = await createParcelGuruShipment(order);
      const { error } = await supabase
        .from('orders')
        .update({ shipment: shipmentDetails })
        .eq('order_id', order.order_id);
      if (error) throw error;

      const { data: fresh } = await supabase
        .from('orders')
        .select('*')
        .eq('order_id', order.order_id)
        .single();
      await sendOrderConfirmationEmail(fresh || order);
    } catch (err) {
      console.error('Post-payment fulfilment error (payment itself is fine):', err.message);
    }
  });
}

// Single source of truth for "this Razorpay order is genuinely paid".
async function markOrderPaid(razorpayOrderId, razorpayPaymentId, fallback = {}) {
  const { data: existing } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', razorpayOrderId)
    .maybeSingle();

  let order = existing;

  if (!order) {
    const { data: inserted, error } = await supabase
      .from('orders')
      .insert({
        order_id: razorpayOrderId,
        payment_id: razorpayPaymentId,
        amount: fallback.amount || 0,
        currency: fallback.currency || 'INR',
        status: "PAID",
        customer: fallback.customer || { name: "Guest Parent", email: "parent@busywud.com" },
        items: fallback.items || []
      })
      .select()
      .single();

    if (error) throw error;
    order = inserted;
  } else if (order.status !== 'PAID') {
    const { data: updated, error } = await supabase
      .from('orders')
      .update({ payment_id: razorpayPaymentId, status: "PAID" })
      .eq('order_id', razorpayOrderId)
      .select()
      .single();

    if (error) throw error;
    order = updated;
  }

  return order;
}

app.post('/api/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, customer, items } = req.body || {};

  try {
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: 'Payment verification is not configured on this server.' });
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Incomplete payment verification payload.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!safeSignatureMatch(expectedSignature, razorpay_signature)) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Razorpay is authoritative on whether money actually moved.
    let rzpOrder = null;
    try {
      rzpOrder = await getRazorpay().orders.fetch(razorpay_order_id);
    } catch (fetchErr) {
      console.error('Could not fetch Razorpay order:', fetchErr.message);
    }

    if (rzpOrder) {
      if (rzpOrder.status !== 'paid') {
        return res.status(400).json({ error: `Payment not completed (order status: ${rzpOrder.status}).` });
      }
      const expectedPaise = Math.round(Number(amount) * 100);
      if (Number.isFinite(expectedPaise) && rzpOrder.amount !== expectedPaise) {
        console.error(`Amount mismatch for ${razorpay_order_id}: paid ${rzpOrder.amount} vs expected ${expectedPaise}`);
        return res.status(400).json({ error: 'Payment amount does not match the order.' });
      }
    }

    const order = await markOrderPaid(razorpay_order_id, razorpay_payment_id, { amount, customer, items });

    fulfilOrderInBackground(order);

    res.json({ success: true, order });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: 'Payment received but could not be saved. Our team has been notified.' });
  }
});

// Safety net: recovers orders whose browser-side verification never completed.
app.post('/api/razorpay/webhook', async (req, res) => {
  const signature = req.get('x-razorpay-signature');

  if (process.env.RAZORPAY_WEBHOOK_SECRET) {
    if (!signature) return res.status(400).json({ error: 'Missing webhook signature' });

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody || '')
      .digest('hex');

    if (!safeSignatureMatch(expected, signature)) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }
  } else {
    console.warn('RAZORPAY_WEBHOOK_SECRET is not set, processing webhook without verification');
  }

  const event = req.body?.event;
  const payload = req.body?.payload || {};
  const entity = payload.payment?.entity || {};

  if (event === 'payment.captured' && entity.order_id) {
    try {
      const order = await markOrderPaid(entity.order_id, entity.id);
      fulfilOrderInBackground(order);
    } catch (err) {
      console.error('Webhook fulfilment error:', err.message);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }

  res.json({ received: true });
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .insert(req.body)
      .select()
      .single();
    
    if (error) throw error;
    res.status(201).json({ success: true, contact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;

// Fails loudly at boot instead of on a customer's first checkout attempt.
// Only reads the account, it never creates an order.
let razorpayAuthState = process.env.RAZORPAY_KEY_ID ? 'unchecked' : 'missing_keys';

async function verifyRazorpayCredentials() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return;

  try {
    const account = await getRazorpay().accounts.fetch();
    razorpayAuthState = 'valid';
    console.log(`Razorpay credentials valid (mode: ${process.env.RAZORPAY_KEY_ID.split('_')[1]})`);

    if (account && account.charge_enabled === false) {
      razorpayAuthState = 'valid_charges_disabled';
      console.warn('WARNING: Razorpay account exists but charges are disabled for it. Live payments will be rejected.');
    }
  } catch (err) {
    const info = classifyRazorpayError(err);
    razorpayAuthState = 'rejected';
    console.error('WARNING: Razorpay credentials REJECTED: ' + info.description);
    console.error('         Checkout will fail for every customer until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are corrected.');
    console.error('         Copy both values from Razorpay Dashboard -> Settings -> API Keys, making sure they are from the same pair and mode.');
  }
}

async function startServer() {
  try {
    console.log("Connecting to Supabase...");

    const { data, error } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true });

    if (error) {
      console.warn('Supabase connection test failed:', error.message);
      console.warn('Store data may be unavailable, admin login will still work.');
    } else {
      console.log('Supabase Connected');
      await seedDefaultProduct();
    }

    verifyRazorpayCredentials();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin`);

      if (!process.env.SESSION_SECRET) {
        console.warn('WARNING: SESSION_SECRET is not set, using the insecure default.');
      }
      if (!ADMIN_CONFIGURED) {
        console.warn('WARNING: ADMIN_EMAIL/ADMIN_PASSWORD not set in .env, admin login is disabled.');
      }
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        console.warn('WARNING: Razorpay keys missing, checkout will fail until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set.');
      } else if (process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
        console.warn('WARNING: Razorpay TEST key in use but the checkout widget uses a LIVE key. Keys must match the same mode.');
      }
      if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
        console.warn('WARNING: RAZORPAY_WEBHOOK_SECRET not set. Payments whose browser verification fails will not be recovered automatically.');
      }
      if (!process.env.TRUST_PROXY && process.env.NODE_ENV === 'production') {
        console.warn('WARNING: TRUST_PROXY not set. Behind a load balancer, client IPs and HTTPS detection will be wrong.');
      }
    });
  } catch (err) {
    console.error('CRITICAL: Supabase Connection Failed');
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_KEY_SECRET
});

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'busywud-admin-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
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

const ProductSchema = new mongoose.Schema({
  title: String,
  category: { type: String, default: 'busy-board' },
  badge: String,
  price: Number,
  oldPrice: Number,
  stock: { type: Number, default: 0 },
  image: String,
  description: String
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  orderId: String,
  paymentId: String,
  amount: Number,
  currency: { type: String, default: "INR" },
  status: { type: String, default: "CREATED" },
  customer: {
    name: String,
    email: String,
    phone: String,
    address: String,
    pincode: String
  },
  items: Array,
  shipment: {
    waybill: String,
    shipmentId: String,
    status: { type: String, default: "PENDING" },
    trackingUrl: String
  }
}, { timestamps: true });

const ContactSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  message: String
}, { timestamps: true });

const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
const Contact = mongoose.model('Contact', ContactSchema);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@busywud.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@3360';

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
      from: '"Busywud Store" <' + (process.env.EMAIL_USER || 'orders@busywud.com') + '>',
      to: order.customer?.email || 'customer@busywud.com',
      subject: 'Order Confirmation - Busywud',
      html: `
        <h2>Thank you for your order!</h2>
        <p>Hi ${order.customer?.name || 'Customer'},</p>
        <p>Your order has been placed successfully.</p>
        <p><strong>Order ID:</strong> ${order.orderId}</p>
        <p><strong>Amount:</strong> ₹${order.amount}</p>
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
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.create({
        title: "GlowLogic Busy Board",
        category: "busy-board",
        badge: "Ages 1 to 4 Years",
        price: 1499,
        oldPrice: 2499,
        stock: 50,
        image: "https://res.cloudinary.com/epwhlldb/image/upload/f_auto,q_auto/v1788360758/glowlogic_busy_board.webp",
        description: "Crafted from 100% natural, non-toxic wood with smooth rounded edges."
      });
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
    const orders = await Order.find({ 'customer.email': email }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer profile update
app.put('/api/my-account', async (req, res) => {
  try {
    const { email, name, phone, address, pincode } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const updated = await Order.findOneAndUpdate(
      { 'customer.email': email },
      { $set: { 'customer.name': name, 'customer.phone': phone, 'customer.address': address, 'customer.pincode': pincode } },
      { new: true }
    );
    res.json({ success: true, customer: updated?.customer || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: update order status / shipment status
app.put('/api/orders/:id', async (req, res) => {
  try {
    const { status, triggerShipment } = req.body;
    const updateData = {};
    if (status) updateData.status = status;
    
    if (triggerShipment) {
      const order = await Order.findById(req.params.id);
      if (order) {
        const shipmentDetails = await createParcelGuruShipment(order);
        updateData.shipment = shipmentDetails;
        if (status) updateData.status = status;
      }
    }
    
    const updated = await Order.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const os = require('os');

app.get('/api/debug/checkout-test', async (req, res) => {
  try {
    const testOrder = await Order.create({
      orderId: 'test_' + Date.now(),
      amount: 100,
      status: "TEST",
      customer: { name: "Test User", email: "test@example.com" },
      items: []
    });
    await Order.findByIdAndDelete(testOrder._id);
    res.json({ success: true, message: 'Checkout simulation passed', orderId: testOrder._id });
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
    
    let dbWriteTest = 'not_tested';
    let dbReadTest = 'not_tested';
    try {
      const testResult = await Product.findOne().limit(1).maxTimeMS(5000);
      dbReadTest = testResult ? 'read_ok' : 'read_ok_empty';
    } catch (err) {
      dbReadTest = 'read_failed: ' + err.message;
    }
    
    try {
      const testOrder = await Order.create({
        orderId: 'test_' + Date.now(),
        amount: 1,
        status: "TEST",
        customer: { name: "Test", email: "test@test.com" },
        items: []
      });
      dbWriteTest = 'write_ok';
      await Order.findByIdAndDelete(testOrder._id);
    } catch (err) {
      dbWriteTest = 'write_failed: ' + err.message;
    }
    
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      serverIps: ips,
      database: dbStatus,
      databaseRead: dbReadTest,
      databaseWrite: dbWriteTest,
      mongoUri: process.env.MONGO_URI ? 'configured' : 'missing',
      razorpayKey: process.env.RAZORPAY_KEY_ID ? 'configured' : 'missing'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/product', async (req, res) => {
  try {
    const product = await Product.findOne();
    if (product) {
      return res.json(product);
    }
    
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
    
    await Product.create(defaultProduct);
    res.json(defaultProduct);
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

app.put('/api/product', async (req, res) => {
  try {
    const updated = await Product.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.adminLoggedIn = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ loggedIn: !!req.session.adminLoggedIn });
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const updated = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, customer, items, currency = "INR" } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    console.log(`Creating order for amount: ${amount}, customer: ${customer?.email || 'guest'}`);

    const options = {
      amount: Math.round(amount * 100),
      currency,
      receipt: `rcpt_${Date.now()}`
    };

    let order;
    let pendingOrder;
    let retries = 3;
    
    while (retries > 0) {
      try {
        order = await razorpay.orders.create(options);
        console.log('Razorpay order created:', order.id);
        
        pendingOrder = await Order.create({
          orderId: order.id,
          amount: amount,
          currency: currency,
          status: "CREATED",
          customer: customer || { name: "Guest Parent", email: "parent@busywud.com" },
          items: items || []
        });
        console.log('Order saved to MongoDB:', pendingOrder._id);
        break;
      } catch (err) {
        retries--;
        console.error(`Order creation attempt failed (${retries} retries left):`, err.message);
        if (retries === 0) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    res.json({ ...order, dbOrderId: pendingOrder._id });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create order. Please try again.' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (razorpay_signature) {
      const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Invalid payment signature" });
      }
    }

    const existingOrder = await Order.findOne({ orderId: razorpay_order_id });
    const shipmentDetails = await createParcelGuruShipment(existingOrder);

    const updatedOrder = await Order.findOneAndUpdate(
      { orderId: razorpay_order_id },
      {
        paymentId: razorpay_payment_id,
        status: "PAID",
        shipment: shipmentDetails
      },
      { new: true }
    );

    await sendOrderConfirmationEmail(updatedOrder);

    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: err.message || 'Payment verification failed' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact', async (req, res) => {
  try {
    const contact = await Contact.create(req.body);
    res.status(201).json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ createdAt: -1 });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    console.log("Connecting to MongoDB Atlas...");
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      connectTimeoutMS: 30000,
      maxPoolSize: 10,
      minPoolSize: 1
    });
    console.log('MongoDB Connected to Cluster1');

    await seedDefaultProduct();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin`);
    });
  } catch (err) {
    console.error('CRITICAL: MongoDB Connection Failed');
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;

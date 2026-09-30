const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets from project root
app.use(express.static(__dirname));

// Serve index.html on root and admin path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Database Schemas
const ProductSchema = new mongoose.Schema({
  title: String,
  badge: String,
  price: Number,
  oldPrice: Number,
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

const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);

// Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Helper: Create Shipment in ParcelGuru
async function createParcelGuruShipment(orderData) {
  try {
    const payload = {
      api_key: process.env.PARCELGURU_API_KEY,
      order_id: orderData.orderId,
      consignee_name: orderData.customer?.name || "Valued Parent",
      consignee_phone: orderData.customer?.phone || "9999999999",
      consignee_email: orderData.customer?.email || "customer@busywud.com",
      consignee_address: orderData.customer?.address || "Customer Address Provided via Checkout",
      consignee_pincode: orderData.customer?.pincode || "411001",
      payment_type: "Prepaid",
      declared_value: orderData.amount,
      weight_kg: 0.8, // Average weight of wooden busy board
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
    console.log("ParcelGuru Shipment Response:", result);

    return {
      waybill: result.waybill || result.awb_code || `PG-${Date.now()}`,
      shipmentId: result.shipment_id || result.id || "",
      status: result.status || "MANIFEST_GENERATED",
      trackingUrl: result.tracking_url || `https://parcelguru.com/track/${result.waybill || ""}`
    };
  } catch (error) {
    console.error("ParcelGuru Integration Error:", error.message);
    return {
      waybill: `PG-OFFLINE-${Date.now()}`,
      shipmentId: "",
      status: "PENDING_MANUAL_DISPATCH"
    };
  }
}

// Seed default product if empty
async function seedDefaultProduct() {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.create({
        title: "GlowLogic Busy Board",
        badge: "Ages 1 to 4 Years",
        price: 1499,
        oldPrice: 2499,
        image: "https://res.cloudinary.com/epwhlldb/image/upload/f_auto,q_auto/v1788360758/glowlogic_busy_board.webp",
        description: "Crafted from 100% natural, non-toxic wood with smooth rounded edges."
      });
      console.log('Seeded GlowLogic Product to MongoDB');
    }
  } catch (err) {
    console.error('Seeding error:', err.message);
  }
}

// ------------------- API ROUTES -------------------

// GET Product
app.get('/api/product', async (req, res) => {
  try {
    const product = await Product.findOne();
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE Product
app.put('/api/product', async (req, res) => {
  try {
    const updated = await Product.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RAZORPAY: Create Order
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, customer, items, currency = "INR" } = req.body;

    const options = {
      amount: Math.round(amount * 100),
      currency,
      receipt: `rcpt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);

    const pendingOrder = await Order.create({
      orderId: order.id,
      amount: amount,
      currency: currency,
      status: "CREATED",
      customer: customer || { name: "Guest Customer", email: "guest@busywud.com" },
      items: items || []
    });

    res.json({ ...order, dbOrderId: pendingOrder._id });
  } catch (error) {
    console.error('Razorpay order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// RAZORPAY: Verify Payment & Auto-book ParcelGuru Shipment
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

    // Retrieve order to feed details to ParcelGuru
    const existingOrder = await Order.findOne({ orderId: razorpay_order_id });

    // Generate courier manifest via ParcelGuru
    const shipmentDetails = await createParcelGuruShipment(existingOrder);

    // Update order with payment and shipment info
    const updatedOrder = await Order.findOneAndUpdate(
      { orderId: razorpay_order_id },
      {
        paymentId: razorpay_payment_id,
        status: "PAID",
        shipment: shipmentDetails
      },
      { new: true }
    );

    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    console.error('Verification/Shipment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET Orders (Shows payment + ParcelGuru tracking info)
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- SERVER BOOTSTRAP -------------------

const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    console.log("Connecting to MongoDB Atlas...");
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('MongoDB Connected to Cluster1');

    await seedDefaultProduct();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('CRITICAL: MongoDB Connection Failed');
    console.error(err.message);
    process.exit(1);
  }
}

startServer();
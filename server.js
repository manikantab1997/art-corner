const multer = require("multer");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();

app.use(cors());
app.use(express.json());

// --------------------
// MongoDB Connection
// --------------------
//mongoose.connect("mongodb://127.0.0.1:27017/artstore")
//    .then(() => console.log("MongoDB Connected"))
  //  .catch(err => console.log(err));

  mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));


// File upload config
const storage = multer.diskStorage({
    destination: "public/uploads/",
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

// --------------------
// Schema & Model
// --------------------
const orderSchema = new mongoose.Schema({
    orderId: String,
    customer: {
        name: String,
        phone: String,
        email: String,
        address: String
    },
    items: Array,
    status: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Order = mongoose.model("Order", orderSchema);
const productSchema = new mongoose.Schema({
    name: String,
    categoryId: Number,
    price: Number,
    image: String,
    inStock: {
        type: Boolean,
        default: true
    }
});

const Product = mongoose.model("Product", productSchema);
// --------------------
// Sample Data
// --------------------
const categories = [
    { id: 1, name: "Candles", image: "/uploads/candle.jpg" },
    { id: 2, name: "Resin Art", image: "/uploads/resin.jpg" },
    { id: 3, name: "Bracelets", image: "/uploads/bracelet.jpg" }
];

// --------------------
// APIs
// --------------------

// Get categories
app.get("/api/categories", (req, res) => {
    res.json(categories);
});

// Get products by category
app.get("/api/products/:categoryId", async (req, res) => {
    const categoryId = Number(req.params.categoryId);

    if (isNaN(categoryId)) {
        return res.status(400).json({ error: "Invalid categoryId" });
    }

    const products = await Product.find({ categoryId });

    res.json(products);
});
// Get products by category
app.post("/api/products", upload.single("image"), async (req, res) => {
    const newProduct = new Product({
        name: req.body.name,
        price: Number(req.body.price),
        categoryId: Number(req.body.categoryId),
        image: "/uploads/" + req.file.filename
    });

    await newProduct.save();

    res.json({ message: "Product added" });
});

// Get single product
app.get("/api/product/:id", async (req, res) => {
    const product = await Product.findById(req.params.id);

    if (!product) {
        return res.status(404).json({ message: "Not found" });
    }

    res.json(product);
});

// Create order
app.post("/api/orders", async (req, res) => {
    try {
        const orderId = "ORD" + Date.now();

        const newOrder = new Order({
            orderId,
            ...req.body,
            status: "Placed"
        });

        await newOrder.save();

        res.json({ orderId });

    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to save order" });
    }
});

// Delete product
app.delete("/api/products/:id", async (req, res) => {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: "Product deleted" });
});

// Toggle stock
app.put("/api/products/:id", async (req, res) => {
    const product = await Product.findById(req.params.id);

    product.inStock = !product.inStock;

    await product.save();

    res.json({ message: "Stock updated" });
});

// Get all products (admin)
app.get("/api/products", async (req, res) => {
    const products = await Product.find();
    res.json(products);
});

// Get all orders (admin)
app.get("/api/orders", async (req, res) => {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
});

app.put("/api/orders/:id", async (req, res) => {
    const { status } = req.body;

    await Order.findOneAndUpdate(
        { orderId: req.params.id },
        { status }
    );

    res.json({ message: "Status updated" });
});

// --------------------
// Serve Frontend
// --------------------
app.use(express.static("public"));

// --------------------
// Start Server
// --------------------
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
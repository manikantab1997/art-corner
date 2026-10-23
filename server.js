const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
const publicDirectory = path.join(__dirname, "public");

// Keep existing cross-origin behavior unless deployment config opts into an origin allowlist.
// Same-origin browser requests do not require CORS; set CORS_ORIGIN to the trusted frontend origin(s).
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(origin => origin.trim()).filter(Boolean)
    : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));
app.use(express.json({ limit: "1mb" }));

const storage = multer.diskStorage({
    destination: path.join(publicDirectory, "uploads"),
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}${path.extname(file.originalname).toLowerCase()}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith("image/")) {
            return cb(new Error("Uploaded file must be an image"));
        }
        cb(null, true);
    }
});

const orderSchema = new mongoose.Schema({
    orderId: String,
    customer: { name: String, phone: String, email: String, address: String },
    items: Array,
    status: String,
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

const productSchema = new mongoose.Schema({
    name: String,
    categoryId: Number,
    price: Number,
    image: String,
    inStock: { type: Boolean, default: true }
});
const Product = mongoose.model("Product", productSchema);

const categories = [
    { id: 1, name: "Candles", image: "/uploads/candle.jpg" },
    { id: 2, name: "Resin Art", image: "/uploads/resin.jpg" },
    { id: 3, name: "Bracelets", image: "/uploads/bracelet.jpg" }
];

app.get("/api/categories", (req, res) => res.json(categories));

app.get("/api/products/:categoryId", async (req, res) => {
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).json({ error: "categoryId must be a positive integer" });
    }
    const products = await Product.find({ categoryId, inStock: true });
    res.json(products);
});

app.post("/api/products", upload.single("image"), async (req, res) => {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const price = Number(req.body.price);
    const categoryId = Number(req.body.categoryId);

    if (!name || name.length > 160) {
        return res.status(400).json({ error: "Product name is required (maximum 160 characters)" });
    }
    if (req.body.price === undefined || req.body.price === "" || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: "A valid non-negative product price is required" });
    }
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).json({ error: "categoryId must be a positive integer" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "A product image is required" });
    }

    const product = await new Product({
        name, price, categoryId, image: `/uploads/${req.file.filename}`
    }).save();
    res.status(201).json({ message: "Product added", product });
});

app.get("/api/product/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: "Invalid product ID" });
    }
    const product = await Product.findById(req.params.id);
    if (!product || !product.inStock) {
        return res.status(404).json({ error: "Product not found" });
    }
    res.json(product);
});

app.post("/api/orders", async (req, res) => {
    try {
        const orderId = `ORD-${randomUUID()}`;
        const newOrder = new Order({ ...req.body, orderId, status: "Placed" });
        await newOrder.save();
        res.status(201).json({ orderId });
    } catch (error) {
        console.error("Order creation failed:", error.message);
        res.status(500).json({ error: "Failed to save order" });
    }
});

app.delete("/api/products/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: "Invalid product ID" });
    }
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json({ message: "Product deleted" });
});

app.put("/api/products/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: "Invalid product ID" });
    }
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    product.inStock = !product.inStock;
    await product.save();
    res.json({ message: "Stock updated", inStock: product.inStock });
});

// Public product data remains limited to in-stock inventory. An all-products admin
// listing must wait for verified server-side admin authorization.
app.get("/api/products", async (req, res) => {
    const products = await Product.find({ inStock: true });
    res.json(products);
});

app.get("/api/orders", async (req, res) => {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
});

app.put("/api/orders/:id", async (req, res) => {
    const { status } = req.body || {};
    const validStatuses = ["Placed", "Shipped", "Delivered"];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Status must be Placed, Shipped, or Delivered" });
    }
    const order = await Order.findOneAndUpdate(
        { orderId: req.params.id }, { status }, { new: true, runValidators: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ message: "Status updated", orderId: order.orderId, status: order.status });
});

app.use(express.static(publicDirectory));

// Express 5 forwards rejected async handlers here. Keep responses generic and logs free of request secrets.
app.use((error, req, res, next) => {
    console.error("Request failed:", error.message);
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON request body" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large" });
    if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller" : "Invalid image upload" });
    }
    if (error.message === "Uploaded file must be an image") {
        return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (require.main === module) {
    const port = process.env.PORT || 3000;
    mongoose.connect(process.env.MONGO_URI)
        .then(() => {
            console.log("MongoDB Connected");
            app.listen(port, () => console.log(`Server running on port ${port}`));
        })
        .catch(error => {
            console.error("MongoDB connection failed:", error.message);
            process.exitCode = 1;
        });
}

module.exports = { app, Product, Order };

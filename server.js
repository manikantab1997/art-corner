const multer = require("multer");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { rateLimit } = require("express-rate-limit");
const { randomUUID, randomBytes, scrypt, timingSafeEqual } = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(scrypt);
const publicDirectory = path.join(__dirname, "public");
const sessionCookieName = "artcorner.sid";
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const maxAdminPasswordLength = 256;
const validStatuses = ["Placed", "Shipped", "Delivered"];

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

function parsePasswordHash(encoded) {
    if (typeof encoded !== "string") return null;
    const match = /^scrypt\$([a-f\d]{32})\$([a-f\d]{128})$/i.exec(encoded);
    if (!match) return null;
    return { salt: Buffer.from(match[1], "hex"), digest: Buffer.from(match[2], "hex") };
}

async function verifyPassword(password, encodedHash) {
    const parsed = parsePasswordHash(encodedHash);
    if (!parsed || typeof password !== "string" || password.length === 0 || password.length > maxAdminPasswordLength) return false;
    const actual = await scryptAsync(password, parsed.salt, parsed.digest.length);
    return timingSafeEqual(actual, parsed.digest);
}

function validateStorefrontOrigin(value, { production = false } = {}) {
    if (typeof value !== "string" || !value) {
        throw new Error("STOREFRONT_ORIGIN must be configured");
    }
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("STOREFRONT_ORIGIN must be a valid origin URL"); }
    if (parsed.origin !== value || parsed.username || parsed.password || (production && parsed.protocol !== "https:")) {
        throw new Error(production
            ? "STOREFRONT_ORIGIN must be an HTTPS origin with no path or credentials"
            : "STOREFRONT_ORIGIN must be an origin with no path or credentials");
    }
    return parsed.origin;
}

function createApp({
    sessionStore = new session.MemoryStore(),
    sessionSecret = randomBytes(32).toString("hex"),
    adminUsername,
    adminPasswordHash,
    production = process.env.NODE_ENV === "production",
    storefrontOrigin = process.env.STOREFRONT_ORIGIN || (production ? null : "http://localhost:3000"),
    rateLimitStore
} = {}) {
    const app = express();
    const trustedStorefrontOrigin = validateStorefrontOrigin(storefrontOrigin, { production });
    if (production) app.set("trust proxy", 1);

    // Public API responses may be read by the configured storefront origin only.
    // Same-origin requests work without CORS; credentialed cross-origin CORS is disabled.
    app.use(cors({ origin: trustedStorefrontOrigin, credentials: false }));
    app.use(express.json({ limit: "1mb" }));
    app.use(session({
        name: sessionCookieName,
        secret: sessionSecret,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: production,
            sameSite: "lax",
            path: "/",
            maxAge: sessionMaxAgeMs
        }
    }));

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

    const requireAdmin = (req, res, next) => {
        if (req.session?.isAdmin === true) return next();
        return res.status(401).json({ error: "Authentication required" });
    };

    // Browser state-changing requests must carry the exact configured storefront origin.
    // This rejects sibling-subdomain and other same-site cross-origin requests as well.
    const requireTrustedOrigin = (req, res, next) => {
        if (req.get("Origin") !== trustedStorefrontOrigin) {
            return res.status(403).json({ error: "Request origin is not allowed" });
        }
        return next();
    };

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many login attempts. Please try again in 15 minutes." },
        ...(rateLimitStore ? { store: rateLimitStore } : {})
    });

    app.get("/api/admin/session", (req, res) => {
        res.json({ authenticated: req.session?.isAdmin === true });
    });

    app.post("/api/admin/login", requireTrustedOrigin, loginLimiter, async (req, res, next) => {
        if (!adminUsername || !parsePasswordHash(adminPasswordHash)) {
            return res.status(503).json({ error: "Admin login is not configured on this server" });
        }
        const { username, password } = req.body || {};
        if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
            return res.status(400).json({ error: "Username and password are required" });
        }
        if (password.length > maxAdminPasswordLength) {
            return res.status(400).json({ error: `Password must be ${maxAdminPasswordLength} characters or fewer` });
        }
        let passwordMatches;
        try {
            passwordMatches = await verifyPassword(password, adminPasswordHash);
        } catch (error) {
            return next(error);
        }
        if (username !== adminUsername || !passwordMatches) {
            return res.status(401).json({ error: "Invalid username or password" });
        }
        req.session.regenerate(error => {
            if (error) return next(error);
            req.session.isAdmin = true;
            req.session.save(saveError => {
                if (saveError) return next(saveError);
                res.json({ authenticated: true });
            });
        });
    });

    app.post("/api/admin/logout", requireTrustedOrigin, (req, res, next) => {
        if (!req.session) {
            res.clearCookie(sessionCookieName, { path: "/", httpOnly: true, secure: production, sameSite: "lax" });
            return res.status(204).end();
        }
        req.session.destroy(error => {
            if (error) return next(error);
            res.clearCookie(sessionCookieName, { path: "/", httpOnly: true, secure: production, sameSite: "lax" });
            res.status(204).end();
        });
    });

    app.get("/api/categories", (req, res) => res.json(categories));

    app.get("/api/products/:categoryId", async (req, res) => {
        const categoryId = Number(req.params.categoryId);
        if (!Number.isInteger(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: "categoryId must be a positive integer" });
        }
        const products = await Product.find({ categoryId, inStock: true });
        res.json(products);
    });

    app.post("/api/products", requireTrustedOrigin, requireAdmin, upload.single("image"), async (req, res) => {
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

    app.delete("/api/products/:id", requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: "Invalid product ID" });
        }
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ error: "Product not found" });
        res.json({ message: "Product deleted" });
    });

    app.put("/api/products/:id", requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: "Invalid product ID" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: "Product not found" });
        product.inStock = !product.inStock;
        await product.save();
        res.json({ message: "Stock updated", inStock: product.inStock });
    });

    // Public product data remains limited to in-stock inventory.
    app.get("/api/products", async (req, res) => {
        const products = await Product.find({ inStock: true });
        res.json(products);
    });

    app.get("/api/orders", requireAdmin, async (req, res) => {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json(orders);
    });

    app.put("/api/orders/:id", requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { status } = req.body || {};
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

    return app;
}

function validateProductionConfig(env = process.env) {
    if (env.NODE_ENV !== "production") {
        throw new Error("NODE_ENV must be explicitly set to production for production startup");
    }
    const missing = ["MONGO_URI", "SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "STOREFRONT_ORIGIN"]
        .filter(name => !env[name]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    if (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.trim() !== env.SESSION_SECRET) {
        throw new Error("SESSION_SECRET must contain at least 32 characters");
    }
    if (!parsePasswordHash(env.ADMIN_PASSWORD_HASH)) {
        throw new Error("ADMIN_PASSWORD_HASH must use scrypt$<32-char-hex-salt>$<128-char-hex-digest> format");
    }
    validateStorefrontOrigin(env.STOREFRONT_ORIGIN, { production: true });
}

// Export a memory-backed app for isolated unit tests only. Production startup below
// creates a separate app with a MongoDB-backed session store and validated secrets.
const app = createApp();

async function startServer() {
    validateProductionConfig();
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
    const store = MongoStore.create({
        client: mongoose.connection.getClient(),
        dbName: mongoose.connection.name,
        collectionName: "sessions",
        ttl: sessionMaxAgeMs / 1000,
        autoRemove: "native"
    });
    const productionApp = createApp({
        sessionStore: store,
        sessionSecret: process.env.SESSION_SECRET,
        adminUsername: process.env.ADMIN_USERNAME,
        adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
        storefrontOrigin: process.env.STOREFRONT_ORIGIN,
        production: process.env.NODE_ENV === "production"
    });
    const port = process.env.PORT || 3000;
    productionApp.listen(port, () => console.log(`Server running on port ${port}`));
}

if (require.main === module) {
    startServer().catch(error => {
        console.error("Server startup failed:", error.message);
        process.exitCode = 1;
    });
}

module.exports = { app, Product, Order, createApp, parsePasswordHash, verifyPassword, validateProductionConfig, validateStorefrontOrigin, sessionCookieName };

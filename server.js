require("dotenv").config({ quiet: true });

const multer = require("multer");
const path = require("path");
const express = require("express");
const { v2: cloudinary } = require("cloudinary");
const cors = require("cors");
const mongoose = require("mongoose");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { rateLimit } = require("express-rate-limit");
const { randomUUID, randomBytes, createHash, createHmac, scrypt, timingSafeEqual } = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(scrypt);
const publicDirectory = path.join(__dirname, "public");
const sessionCookieName = "artcorner.sid";
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const maxAdminPasswordLength = 256;
const maxProductImageBytes = 5 * 1024 * 1024;
const validStatuses = ["Placed", "Shipped", "Delivered"];
const supportedImageTypes = new Map([
    [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
    [".png", "image/png"], [".webp", "image/webp"], [".gif", "image/gif"]
]);

function cloudinaryConfigMissing(env = process.env) {
    return ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
        .filter(name => !env[name] || !env[name].trim());
}

function configureCloudinary(env = process.env, client = cloudinary) {
    if (cloudinaryConfigMissing(env).length) return false;
    client.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        secure: true
    });
    return true;
}

function hasSupportedImageSignature(file) {
    if (!file || !Buffer.isBuffer(file.buffer)) return false;
    const expectedMime = supportedImageTypes.get(path.extname(file.originalname || "").toLowerCase());
    if (!expectedMime || file.mimetype !== expectedMime) return false;
    const buffer = file.buffer;
    if (expectedMime === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (expectedMime === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (expectedMime === "image/gif") return buffer.subarray(0, 4).toString("ascii") === "GIF8";
    if (expectedMime === "image/webp") return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    return false;
}

function uploadImageToCloudinary(file, client = cloudinary) {
    return new Promise((resolve, reject) => {
        const stream = client.uploader.upload_stream({ folder: "art-corner/products", resource_type: "image" }, (error, result) => {
            if (error || !result || typeof result.public_id !== "string" || !/^https:\/\//i.test(result.secure_url || "")) {
                return reject(new Error("Image storage service could not upload the image"));
            }
            resolve({ secureUrl: result.secure_url, publicId: result.public_id });
        });
        stream.end(file.buffer);
    });
}

const orderSchema = new mongoose.Schema({
    orderId: String,
    publicReference: { type: String, default: undefined },
    customer: { name: String, phone: String, email: String, address: String },
    items: Array,
    status: String,
    createdAt: { type: Date, default: Date.now },
    idempotencyKey: { type: String, select: false },
    requestHash: { type: String, select: false },
    whatsappNotificationStatus: {
        type: String,
        enum: ["pending", "sending", "sent", "failed", "unknown", "not_configured"],
        default: "not_configured"
    },
    whatsappNotificationAttempts: { type: Number, default: 0 },
    whatsappNotificationAttemptedAt: Date,
    whatsappNotificationMessageId: String
});
orderSchema.index({ idempotencyKey: 1 }, {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } }
});
orderSchema.index({ publicReference: 1 }, {
    unique: true,
    partialFilterExpression: { publicReference: { $type: "string" } }
});
const Order = mongoose.model("Order", orderSchema);

const categorySchema = new mongoose.Schema({
    id: { type: Number, required: true, min: 1 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    normalizedName: { type: String, required: true },
    image: { type: String, default: null },
    pendingProductAssignments: { type: Number, default: 0, min: 0 },
    deleting: { type: Boolean, default: false }
}, { versionKey: false });
categorySchema.index({ id: 1 }, { unique: true });
categorySchema.index({ normalizedName: 1 }, { unique: true });
const Category = mongoose.model("Category", categorySchema);

const categoryCounterSchema = new mongoose.Schema({
    _id: String,
    sequence: { type: Number, required: true }
}, { versionKey: false, collection: "category_counters" });
const CategoryCounter = mongoose.model("CategoryCounter", categoryCounterSchema);

const productSchema = new mongoose.Schema({
    name: String,
    categoryId: Number,
    price: Number,
    image: String,
    imagePublicId: { type: String, select: false, default: undefined },
    customizationEnabled: { type: Boolean, default: false },
    inStock: { type: Boolean, default: true }
});
const Product = mongoose.model("Product", productSchema);

const legacyCategories = [
    { id: 1, name: "Candles", image: "/uploads/candle.jpg" },
    { id: 2, name: "Resin Art", image: "/uploads/resin.jpg" },
    { id: 3, name: "Bracelets", image: "/uploads/bracelet.jpg" }
];

function normalizeCategoryName(name) {
    return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

async function seedLegacyCategories() {
    const existing = await Category.find({}).lean();
    const seenIds = new Map();
    const seenNames = new Map();
    for (const category of existing) {
        if (!Number.isSafeInteger(category.id) || category.id <= 0 || typeof category.name !== "string" || !category.name.trim()) {
            throw new Error("Existing Category records contain an invalid numeric ID or name; resolve them before startup");
        }
        const normalizedName = normalizeCategoryName(category.name);
        if (!category.normalizedName || category.normalizedName !== normalizedName) {
            throw new Error(`Existing category ID ${category.id} has a missing or inconsistent normalized name; resolve it before startup`);
        }
        if (seenIds.has(category.id)) throw new Error(`Conflicting existing Category records use numeric ID ${category.id}`);
        if (seenNames.has(normalizedName)) throw new Error(`Conflicting existing Category records share the name "${category.name}"`);
        seenIds.set(category.id, category);
        seenNames.set(normalizedName, category);
    }

    for (const legacy of legacyCategories) {
        const byId = seenIds.get(legacy.id);
        const byName = seenNames.get(normalizeCategoryName(legacy.name));
        if (byId && normalizeCategoryName(byId.name) !== normalizeCategoryName(legacy.name)) {
            throw new Error(`Category ID ${legacy.id} is already assigned to "${byId.name}"; expected "${legacy.name}". No categories were seeded`);
        }
        if (byName && byName.id !== legacy.id) {
            throw new Error(`Category "${legacy.name}" already uses ID ${byName.id}; expected ID ${legacy.id}. No categories were seeded`);
        }
    }

    const knownCategoryIds = new Set([...seenIds.keys(), ...legacyCategories.map(category => category.id)]);
    const productCategoryIds = await Product.distinct("categoryId");
    for (const id of productCategoryIds) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new Error("Existing products contain an invalid categoryId; resolve it before category seeding");
        }
        if (!knownCategoryIds.has(id)) {
            throw new Error(`Existing products use categoryId ${id}, but no category name is defined for it; resolve this conflict before startup`);
        }
    }

    await Category.init();
    for (const legacy of legacyCategories) {
        try {
            await Category.updateOne({ id: legacy.id }, {
                $setOnInsert: { ...legacy, normalizedName: normalizeCategoryName(legacy.name) }
            }, { upsert: true });
        } catch (error) {
            if (error.code === 11000) {
                const concurrentCategory = await Category.findOne({ id: legacy.id }).lean();
                if (concurrentCategory && normalizeCategoryName(concurrentCategory.name) === normalizeCategoryName(legacy.name)) continue;
                throw new Error(`A concurrent category change conflicts with legacy category ID ${legacy.id}; no existing category was overwritten`);
            }
            throw error;
        }
    }

    const maxCategory = await Category.findOne().sort({ id: -1 }).select({ id: 1 }).lean();
    await CategoryCounter.findOneAndUpdate({ _id: "category" }, {
        $max: { sequence: Math.max(3, maxCategory?.id || 0) }
    }, { upsert: true, new: true });
}

function publicCategory(category) {
    return { id: category.id, name: category.name, image: category.image || null };
}

function generatePublicOrderReference() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const random = randomBytes(5);
    return `AC-${Array.from(random, byte => alphabet[byte & 31]).join("")}`;
}

function createOrderConfirmationToken(orderReference, secret, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ orderReference, expiresAt: now + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function verifyOrderConfirmationToken(token, secret, now = Date.now()) {
    if (typeof token !== "string" || token.length > 1024) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    let actual;
    try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        const validReference = /^AC-[A-HJ-NP-Z2-9]{5}$/.test(data.orderReference) || /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.orderReference);
        if (!validReference || !Number.isFinite(data.expiresAt) || data.expiresAt <= now) return null;
        return data.orderReference;
    } catch { return null; }
}

function getWhatsAppConfig(env = process.env) {
    const required = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_RECIPIENT", "WHATSAPP_TEMPLATE_NAME"];
    const configured = required.filter(key => typeof env[key] === "string" && env[key].trim());
    if (configured.length === 0) return null;
    if (configured.length !== required.length) throw new Error("WhatsApp notification configuration is incomplete");
    const config = {
        accessToken: env.WHATSAPP_ACCESS_TOKEN.trim(),
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID.trim(),
        recipient: env.WHATSAPP_BUSINESS_RECIPIENT.trim(),
        templateName: env.WHATSAPP_TEMPLATE_NAME.trim(),
        apiVersion: env.WHATSAPP_API_VERSION || "v23.0",
        language: env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US"
    };
    if (!/^\d+$/.test(config.phoneNumberId) || !/^\d{8,15}$/.test(config.recipient) ||
        !/^[a-z0-9_]{1,512}$/.test(config.templateName) || !/^v\d+\.\d+$/.test(config.apiVersion) ||
        !/^[a-z]{2}_[A-Z]{2}$/.test(config.language)) {
        throw new Error("WhatsApp notification configuration is invalid");
    }
    return config;
}

function buildWhatsAppOrderPayload(order, config) {
    const items = Array.isArray(order.items) ? order.items : [];
    const itemText = items.map(item => `${String(item.name || "Item").slice(0, 80)} × ${Number(item.qty ?? item.quantity) || 0}`).join(", ").slice(0, 900) || "No item details";
    const total = items.every(item => Number.isFinite(Number(item.price)) && Number.isFinite(Number(item.qty ?? item.quantity)))
        ? items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty ?? item.quantity), 0)
        : null;
    const components = [String(order.orderId).slice(0, 100), itemText, total === null ? "Not available" : total.toFixed(2), String(order._id).slice(0, 100)];
    return {
        messaging_product: "whatsapp", recipient_type: "individual", to: config.recipient,
        type: "template",
        template: {
            name: config.templateName, language: { code: config.language },
            components: [{ type: "body", parameters: components.map(text => ({ type: "text", text })) }]
        }
    };
}

async function sendWhatsAppOrderNotification(order, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const config = getWhatsAppConfig(env);
    if (!config) return { status: "not_configured" };
    if (typeof fetchImpl !== "function") return { status: "failed" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetchImpl(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
            method: "POST", signal: controller.signal,
            headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(buildWhatsAppOrderPayload(order, config))
        });
        if (!response.ok) return { status: response.status >= 500 ? "unknown" : "failed" };
        const data = await response.json().catch(() => ({}));
        return { status: "sent", messageId: typeof data.messages?.[0]?.id === "string" ? data.messages[0].id : undefined };
    } catch {
        // A network failure is ambiguous: Meta may have accepted the request.
        return { status: "unknown" };
    } finally {
        clearTimeout(timeout);
    }
}

async function processOrderWhatsAppNotification(orderId, { retry = false, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    let config;
    try { config = getWhatsAppConfig(env); }
    catch { return { status: "not_configured" }; }
    if (!config) return { status: "not_configured" };
    const order = await Order.findOne({ orderId });
    if (!order) return { status: "not_found" };
    const allowed = retry ? ["failed", "not_configured", "pending"] : ["pending"];
    const claimed = await Order.findOneAndUpdate(
        { orderId, whatsappNotificationStatus: { $in: allowed } },
        { $set: { whatsappNotificationStatus: "sending", whatsappNotificationAttemptedAt: new Date() }, $inc: { whatsappNotificationAttempts: 1 } },
        { new: true }
    );
    if (!claimed) {
        const current = await Order.findOne({ orderId });
        return { status: current?.whatsappNotificationStatus || "sending" };
    }
    const outcome = await sendWhatsAppOrderNotification(claimed, { env, fetchImpl });
    try {
        const updateResult = await Order.updateOne({ orderId, whatsappNotificationStatus: "sending" }, {
            $set: {
                whatsappNotificationStatus: outcome.status,
                ...(outcome.messageId ? { whatsappNotificationMessageId: outcome.messageId } : {})
            }
        });
        if (updateResult.matchedCount === 0 || updateResult.modifiedCount === 0) {
            console.error("WhatsApp notification outcome could not be saved; reconciliation is required");
            return { status: "unknown" };
        }
    } catch {
        console.error("WhatsApp notification outcome could not be saved; reconciliation is required");
        return { status: "unknown" };
    }
    return outcome;
}

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
    sessionStore,
    sessionSecret = randomBytes(32).toString("hex"),
    adminUsername,
    adminPasswordHash,
    production = process.env.NODE_ENV === "production",
    storefrontOrigin = process.env.STOREFRONT_ORIGIN || (production ? null : "http://localhost:3000"),
    rateLimitStore,
    cloudinaryClient = cloudinary,
    cloudinaryConfigured = cloudinaryConfigMissing().length === 0,
    whatsappEnv = process.env,
    whatsappFetch = globalThis.fetch
} = {}) {
    if (production && (!sessionStore || sessionStore instanceof session.MemoryStore)) {
        throw new Error("A persistent session store is required in production");
    }
    const configuredSessionStore = sessionStore || new session.MemoryStore();
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
        store: configuredSessionStore,
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

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxProductImageBytes },
        fileFilter: (req, file, cb) => {
            const extension = path.extname(file.originalname || "").toLowerCase();
            if (!supportedImageTypes.has(extension) || file.mimetype !== supportedImageTypes.get(extension)) {
                const error = new Error("Upload a JPEG, PNG, WebP, or GIF image");
                error.code = "UNSUPPORTED_IMAGE_TYPE";
                return cb(error);
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

    // Same-origin browser GETs may omit Origin. Permit that read only when browser
    // Fetch Metadata and Host both identify the configured storefront exactly.
    const requireTrustedReadOrigin = (req, res, next) => {
        const origin = req.get("Origin");
        if (origin === trustedStorefrontOrigin) return next();
        const trustedHost = new URL(trustedStorefrontOrigin).host;
        if (origin === undefined && req.get("Sec-Fetch-Site") === "same-origin" && req.get("Host") === trustedHost) {
            return next();
        }
        return res.status(403).json({ error: "Request origin is not allowed" });
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

    app.get("/api/categories", async (req, res) => {
        const categories = await Category.find().sort({ id: 1 }).lean();
        res.json(categories.map(publicCategory));
    });

    app.post("/api/categories", requireTrustedOrigin, requireAdmin, async (req, res) => {
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
            return res.status(400).json({ error: "Category name is required and must be 80 characters or fewer" });
        }

        const normalizedName = normalizeCategoryName(name);
        if (await Category.findOne({ normalizedName })) {
            return res.status(409).json({ error: "A category with that name already exists" });
        }

        const counter = await CategoryCounter.findOneAndUpdate({ _id: "category", sequence: { $lt: Number.MAX_SAFE_INTEGER } }, {
            $inc: { sequence: 1 }
        }, { new: true });
        if (!counter || !Number.isSafeInteger(counter.sequence)) {
            return res.status(503).json({ error: "No category IDs are currently available" });
        }
        try {
            const category = await new Category({
                id: counter.sequence,
                name,
                normalizedName,
                image: null
            }).save();
            return res.status(201).json({ message: "Category created", category: publicCategory(category) });
        } catch (error) {
            if (error.code === 11000) {
                return res.status(409).json({ error: "A category with that name or ID already exists. Refresh and try again." });
            }
            throw error;
        }
    });

    app.put("/api/categories/:id", requireTrustedOrigin, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: "Category ID must be a positive integer" });
        }
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
            return res.status(400).json({ error: "Category name is required and must be 80 characters or fewer" });
        }

        const normalizedName = normalizeCategoryName(name);
        const currentCategory = await Category.findOne({ id }).lean();
        if (!currentCategory) return res.status(404).json({ error: "Category not found" });
        if (currentCategory.deleting) return res.status(409).json({ error: "Category is being deleted. Refresh and try again." });

        const duplicate = await Category.findOne({ normalizedName }).lean();
        if (duplicate && duplicate.id !== id) {
            return res.status(409).json({ error: "A category with that name already exists" });
        }

        try {
            const category = await Category.findOneAndUpdate(
                { id, deleting: { $ne: true } },
                { $set: { name, normalizedName } },
                { new: true, runValidators: true }
            );
            if (!category) return res.status(409).json({ error: "Category is being modified. Refresh and try again." });
            return res.json({ message: "Category renamed", category: publicCategory(category) });
        } catch (error) {
            if (error.code === 11000) {
                return res.status(409).json({ error: "A category with that name already exists" });
            }
            throw error;
        }
    });

    app.delete("/api/categories/:id", requireTrustedOrigin, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: "Category ID must be a positive integer" });
        }
        const initialCategory = await Category.findOne({ id }).lean();
        if (!initialCategory) return res.status(404).json({ error: "Category not found" });
        if (id <= 3) {
            return res.status(409).json({ error: "The original Candles, Resin Art, and Bracelets categories cannot be deleted" });
        }

        // Mark the category unavailable before checking products. Product creation
        // atomically reserves an assignment against this same document, closing the
        // race between the product check and category deletion across server instances.
        let category = await Category.findOneAndUpdate(
            { id, deleting: { $ne: true } },
            { $set: { deleting: true } },
            { new: true }
        );
        if (!category) {
            category = await Category.findOne({ id }).lean();
            if (!category) return res.status(404).json({ error: "Category not found" });
            if (!category.deleting) return res.status(409).json({ error: "Category is being modified. Refresh and try again." });
        }

        const releaseDeletionLock = async () => {
            await Category.updateOne({ id, deleting: true }, { $set: { deleting: false } });
        };

        try {
            if ((category.pendingProductAssignments || 0) > 0) {
                await releaseDeletionLock();
                return res.status(409).json({ error: "A product is being assigned to this category. Try again shortly." });
            }
            if (await Product.exists({ categoryId: id })) {
                await releaseDeletionLock();
                return res.status(409).json({ error: "This category still has products assigned, including out-of-stock products" });
            }
            const result = await Category.deleteOne({ id, deleting: true, pendingProductAssignments: { $in: [null, 0] } });
            if (result.deletedCount !== 1) {
                await releaseDeletionLock();
                return res.status(409).json({ error: "Category is being modified. Refresh and try again." });
            }
            return res.json({ message: "Category deleted", id });
        } catch (error) {
            await releaseDeletionLock().catch(() => {});
            throw error;
        }
    });

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
        if (req.body.customizationEnabled !== undefined && !["true", "false"].includes(req.body.customizationEnabled)) {
            return res.status(400).json({ error: "customizationEnabled must be true or false" });
        }
        if (!req.file) {
            return res.status(400).json({ error: "A product image is required" });
        }
        if (!hasSupportedImageSignature(req.file)) {
            return res.status(400).json({ error: "The uploaded file is not a valid JPEG, PNG, WebP, or GIF image" });
        }
        if (!cloudinaryConfigured) {
            return res.status(503).json({ error: "Product image storage is not configured on this server" });
        }
        const categoryReservation = await Category.findOneAndUpdate(
            { id: categoryId, deleting: { $ne: true } },
            { $inc: { pendingProductAssignments: 1 } },
            { new: true }
        );
        if (!categoryReservation) {
            return res.status(400).json({ error: "Selected category does not exist or is being deleted" });
        }

        const releaseReservation = () => Category.updateOne(
            { id: categoryId, pendingProductAssignments: { $gt: 0 } },
            { $inc: { pendingProductAssignments: -1 } }
        );
        let uploadedImage;
        try {
            uploadedImage = await uploadImageToCloudinary(req.file, cloudinaryClient);
        } catch {
            try { await releaseReservation(); } catch { console.error("Product category reservation cleanup failed"); }
            return res.status(502).json({ error: "Image upload failed. Please try again." });
        }

        let product;
        try {
            product = await new Product({
                name, price, categoryId, image: uploadedImage.secureUrl, imagePublicId: uploadedImage.publicId,
                customizationEnabled: req.body.customizationEnabled === "true"
            }).save();
        } catch (error) {
            // A rejected database save can have an ambiguous commit result. Retain
            // the Cloudinary asset rather than risk deleting an image now referenced.
            try { await releaseReservation(); } catch { console.error("Product category reservation cleanup failed"); }
            throw error;
        }
        try {
            await releaseReservation();
        } catch {
            // Keep the assignment reservation fail-closed; deletion will refuse
            // while it remains, and the successful product response stays accurate.
            console.error("Product category reservation cleanup failed");
        }
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

    // Confirmation tokens are short-lived, signed capabilities for one order's
    // non-sensitive summary. They are sent in a header, never placed in URLs.
    app.get("/api/order-confirmation", async (req, res) => {
        const orderReference = verifyOrderConfirmationToken(req.get("X-Order-Confirmation"), sessionSecret);
        if (!orderReference) return res.status(401).json({ error: "Order confirmation could not be verified" });
        const query = orderReference.startsWith("AC-") ? { publicReference: orderReference } : { orderId: orderReference };
        const order = await Order.findOne(query).select({ orderId: 1, publicReference: 1, status: 1, items: 1 }).lean();
        if (!order) return res.status(404).json({ error: "Order confirmation is unavailable" });
        const items = Array.isArray(order.items) ? order.items.map(item => ({
            name: typeof item.name === "string" ? item.name : "Handmade item",
            qty: Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1,
            price: Number.isFinite(Number(item.price)) ? Number(item.price) : null
        })) : [];
        res.json({ publicReference: order.publicReference || order.orderId, status: order.status || "Placed", items });
    });

    app.post("/api/orders", async (req, res) => {
        const idempotencyKey = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
        if (idempotencyKey === undefined) {
            return res.status(400).json({ error: "Checkout key is missing. Refresh checkout and try again." });
        }
        if (idempotencyKey !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
            return res.status(400).json({ error: "Idempotency-Key must be a UUID v4" });
        }
        const requestHash = createHash("sha256").update(JSON.stringify(req.body || {})).digest("hex");
        try {
            const orderId = `ORD-${randomUUID()}`;
            let initialNotificationStatus = "pending";
            try { if (!getWhatsAppConfig(whatsappEnv)) initialNotificationStatus = "not_configured"; }
            catch { initialNotificationStatus = "not_configured"; }
            const newOrder = new Order({
                ...req.body, orderId, publicReference: generatePublicOrderReference(), status: "Placed",
                ...(idempotencyKey ? { idempotencyKey, requestHash } : {}),
                whatsappNotificationStatus: initialNotificationStatus
            });
            let orderSaved = false;
            for (let attempt = 0; attempt < 5 && !orderSaved; attempt++) {
                try {
                    await newOrder.save();
                    orderSaved = true;
                } catch (saveError) {
                    if (saveError.code !== 11000 || !saveError.keyPattern?.publicReference || attempt === 4) throw saveError;
                    newOrder.publicReference = generatePublicOrderReference();
                }
            }
            try {
                if (initialNotificationStatus === "pending") {
                    await processOrderWhatsAppNotification(orderId, { env: whatsappEnv, fetchImpl: whatsappFetch });
                }
            } catch {
                console.error("WhatsApp notification processing failed; order remains saved for reconciliation");
            }
            res.status(201).json({
                orderId,
                publicReference: newOrder.publicReference,
                confirmationToken: createOrderConfirmationToken(newOrder.publicReference, sessionSecret)
            });
        } catch (error) {
            if (error.code === 11000 && idempotencyKey) {
                try {
                    const existing = await Order.findOne({ idempotencyKey }).select("+idempotencyKey +requestHash");
                    if (existing) {
                        if (existing.requestHash !== requestHash) return res.status(409).json({ error: "This checkout key was already used for a different order" });
                        return res.status(200).json({
                            orderId: existing.orderId,
                            publicReference: existing.publicReference || existing.orderId,
                            confirmationToken: createOrderConfirmationToken(existing.publicReference || existing.orderId, sessionSecret)
                        });
                    }
                } catch {
                    // Fall through to a generic safe error if the idempotency lookup fails.
                }
            }
            console.error("Order creation failed");
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
        if (Object.prototype.hasOwnProperty.call(req.body || {}, "customizationEnabled")) {
            if (typeof req.body.customizationEnabled !== "boolean") {
                return res.status(400).json({ error: "customizationEnabled must be a boolean" });
            }
            product.customizationEnabled = req.body.customizationEnabled;
            await product.save();
            return res.json({ message: "Customization setting updated", customizationEnabled: product.customizationEnabled });
        }
        product.inStock = !product.inStock;
        await product.save();
        res.json({ message: "Stock updated", inStock: product.inStock });
    });

    // Public product data remains limited to in-stock inventory.
    app.get("/api/products", async (req, res) => {
        const products = await Product.find({ inStock: true });
        res.json(products);
    });

    app.get("/api/admin/products", requireTrustedReadOrigin, requireAdmin, async (req, res) => {
        const products = await Product.find({});
        res.json(products);
    });

    app.get("/api/orders", requireAdmin, async (req, res) => {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json(orders);
    });

    app.post("/api/admin/orders/:id/whatsapp-notification/retry", requireTrustedOrigin, requireAdmin, async (req, res) => {
        const outcome = await processOrderWhatsAppNotification(req.params.id, { retry: true, env: whatsappEnv, fetchImpl: whatsappFetch });
        if (outcome.status === "not_found") return res.status(404).json({ error: "Order not found" });
        if (outcome.status === "not_configured") return res.status(503).json({ error: "WhatsApp notification is not configured" });
        if (outcome.status === "unknown" || outcome.status === "sending") return res.status(409).json({ error: "Notification outcome is uncertain. Check Meta delivery records before retrying." });
        return res.json({ status: outcome.status });
    });

    app.post("/api/admin/orders/:id/whatsapp-notification/confirm-sent", requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (req.body?.confirmed !== true) return res.status(400).json({ error: "Explicit confirmation is required" });
        const result = await Order.updateOne(
            { orderId: req.params.id, whatsappNotificationStatus: { $in: ["unknown", "sending"] }, whatsappNotificationAttemptedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
            { $set: { whatsappNotificationStatus: "sent" } }
        );
        if (result.modifiedCount !== 1) return res.status(409).json({ error: "Only an uncertain notification older than five minutes can be reconciled" });
        return res.json({ status: "sent" });
    });

    app.post("/api/admin/orders/:id/whatsapp-notification/confirm-not-sent-retry", requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (req.body?.confirmedNotSent !== true) return res.status(400).json({ error: "Explicit confirmation is required" });
        const result = await Order.updateOne(
            { orderId: req.params.id, whatsappNotificationStatus: { $in: ["unknown", "sending"] }, whatsappNotificationAttemptedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
            { $set: { whatsappNotificationStatus: "failed" } }
        );
        if (result.modifiedCount !== 1) return res.status(409).json({ error: "Only an uncertain notification older than five minutes can be reconciled" });
        const outcome = await processOrderWhatsAppNotification(req.params.id, { retry: true, env: whatsappEnv, fetchImpl: whatsappFetch });
        if (outcome.status === "not_configured") return res.status(503).json({ error: "WhatsApp notification is not configured" });
        if (["unknown", "sending"].includes(outcome.status)) return res.status(409).json({ error: "Retry outcome is uncertain. Check Meta delivery records before taking further action." });
        return res.json({ status: outcome.status });
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
        if (error.code === "UNSUPPORTED_IMAGE_TYPE") {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: "Something went wrong. Please try again." });
    });

    return app;
}

function verifySessionStoreReady(store, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        if (!store || typeof store.get !== "function") {
            reject(new Error("A valid session store is required before startup"));
            return;
        }
        // connect-mongo initializes its collection and TTL index on first use.
        // Probe with a non-existent ID so those failures happen before listen().
        let settled = false;
        const timeout = setTimeout(() => {
            settled = true;
            reject(new Error(`Session store readiness check timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
        };
        try {
            store.get("__startup_readiness_check__", finish);
        } catch (error) {
            finish(error);
        }
    });
}

async function runStartupStage(stageName, operation, logger = console) {
    const startedAt = Date.now();
    logger.log(`Startup stage "${stageName}" started`);
    try {
        const result = await operation();
        logger.log(`Startup stage "${stageName}" completed in ${Date.now() - startedAt} ms`);
        return result;
    } catch (error) {
        logger.error(`Startup stage "${stageName}" failed after ${Date.now() - startedAt} ms (${error?.name || "Error"})`);
        throw error;
    }
}

function validateProductionConfig(env = process.env) {
    if (env.NODE_ENV !== "production") {
        throw new Error("NODE_ENV must be explicitly set to production for production startup");
    }
    const missing = ["MONGO_URI", "SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "STOREFRONT_ORIGIN"]
        .filter(name => !env[name]);
    missing.push(...cloudinaryConfigMissing(env));
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    if (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.trim() !== env.SESSION_SECRET) {
        throw new Error("SESSION_SECRET must contain at least 32 characters");
    }
    if (!parsePasswordHash(env.ADMIN_PASSWORD_HASH)) {
        throw new Error("ADMIN_PASSWORD_HASH must use scrypt$<32-char-hex-salt>$<128-char-hex-digest> format");
    }
    validateStorefrontOrigin(env.STOREFRONT_ORIGIN, { production: true });
}

// Unit tests import a memory-backed app. Production creates only the MongoDB-backed
// app below; never instantiate an unused MemoryStore app in the production process.
configureCloudinary();
const app = process.env.NODE_ENV === "production" ? null : createApp();

async function startServer() {
    validateProductionConfig();
    configureCloudinary();
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
    await runStartupStage("legacy category seeding", seedLegacyCategories);
    await runStartupStage("order index creation", () => Order.createIndexes());
    const store = MongoStore.create({
        client: mongoose.connection.getClient(),
        dbName: mongoose.connection.name,
        collectionName: "sessions",
        ttl: sessionMaxAgeMs / 1000,
        autoRemove: "native"
    });
    await runStartupStage("MongoDB session-store readiness", () => verifySessionStoreReady(store));
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
        console.error(`Server startup failed (${error?.name || "Error"})`);
        process.exitCode = 1;
    });
}

module.exports = { app, Product, Order, Category, CategoryCounter, createApp, seedLegacyCategories, parsePasswordHash, verifyPassword, validateProductionConfig, validateStorefrontOrigin, sessionCookieName, hasSupportedImageSignature, uploadImageToCloudinary, getWhatsAppConfig, buildWhatsAppOrderPayload, sendWhatsAppOrderNotification, processOrderWhatsAppNotification, generatePublicOrderReference, createOrderConfirmationToken, verifyOrderConfirmationToken, verifySessionStoreReady, runStartupStage };

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, scryptSync } = require("node:crypto");
const session = require("express-session");
const mongoose = require("mongoose");

process.env.NODE_ENV = "test";
const {
  Product, Category, CategoryCounter, createApp, seedLegacyCategories, sessionCookieName
} = require("../server");

const baseUri = process.env.CATEGORY_TEST_MONGO_BASE_URI;
if (!baseUri) {
  throw new Error("Set CATEGORY_TEST_MONGO_BASE_URI to a local mongodb:// loopback URI before running this opt-in suite");
}

let parsedBaseUri;
try {
  parsedBaseUri = new URL(baseUri);
} catch {
  throw new Error("CATEGORY_TEST_MONGO_BASE_URI is not a valid MongoDB URI");
}
if (parsedBaseUri.protocol !== "mongodb:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsedBaseUri.hostname)) {
  throw new Error("This integration suite only accepts a local mongodb:// loopback URI; remote databases are refused");
}
if (parsedBaseUri.host.includes(",") || parsedBaseUri.searchParams.has("replicaSet") || parsedBaseUri.searchParams.get("loadBalanced") === "true") {
  throw new Error("This suite refuses multi-host, replica-set, and load-balanced MongoDB URIs");
}
parsedBaseUri.searchParams.set("directConnection", "true");

const disposableDatabaseName = `art_corner_disposable_test_${randomBytes(12).toString("hex")}`;
const disposableNamePattern = /^art_corner_disposable_test_[a-f0-9]{24}$/;
if (!disposableNamePattern.test(disposableDatabaseName)) {
  throw new Error("Generated disposable database name did not match the required safety pattern");
}
parsedBaseUri.pathname = `/${disposableDatabaseName}`;
const disposableUri = parsedBaseUri.toString();
let verifiedDisposableDatabase = false;
const storefrontOrigin = "https://storefront.integration.test";
const adminUsername = "phase2b-integration-admin";
const password = "phase2b-integration-only-password";
const salt = randomBytes(16);
const adminPasswordHash = `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;

before(async () => {
  await mongoose.connect(disposableUri, { serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, disposableDatabaseName, "connected database must be the generated disposable database");
  assert.match(mongoose.connection.name, disposableNamePattern, "connected database name must match the disposable pattern");
  const existingCollections = await mongoose.connection.db.listCollections().toArray();
  assert.equal(existingCollections.length, 0, "refusing to write to a generated database that already contains collections");
  verifiedDisposableDatabase = true;
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1 && verifiedDisposableDatabase) {
      const currentName = mongoose.connection.name;
      if (currentName !== disposableDatabaseName || !disposableNamePattern.test(currentName)) {
        throw new Error("Refusing cleanup because the active database is not the verified disposable test database");
      }
      await mongoose.connection.dropDatabase();
    }
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
});

async function resetDisposableCollections() {
  assert.equal(verifiedDisposableDatabase, true, "database must be verified before writes");
  assert.equal(mongoose.connection.name, disposableDatabaseName);
  await Promise.all([Product.deleteMany({}), Category.deleteMany({}), CategoryCounter.deleteMany({})]);
  await Category.init();
  // Model.init() caches its initialisation promise. Recreate declared indexes
  // explicitly because an earlier disposable-test collection drop may remove them.
  await Category.createIndexes();
  await CategoryCounter.init();
}

async function assertCategoryUniqueIndexes() {
  const indexes = await Category.collection.listIndexes().toArray();
  for (const field of ["id", "normalizedName"]) {
    const index = indexes.find(candidate => {
      const keys = Object.entries(candidate.key);
      return keys.length === 1 && keys[0][0] === field && keys[0][1] === 1;
    });
    assert.ok(index, `MongoDB must have a single-field ascending ${field} index`);
    assert.equal(index.unique, true, `MongoDB ${field} index must be unique`);
  }
}

async function withAdminApi(callback) {
  const app = createApp({
    sessionStore: new session.MemoryStore(),
    sessionSecret: "phase2b-local-integration-secret-32chars-minimum",
    adminUsername,
    adminPasswordHash,
    production: false,
    storefrontOrigin
  });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  async function request(route, { method = "GET", cookie, body } = {}) {
    const headers = { Origin: storefrontOrigin };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${route}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { response, text: await response.text(), setCookies: response.headers.getSetCookie() };
  }
  try {
    const login = await request("/api/admin/login", {
      method: "POST", body: { username: adminUsername, password }
    });
    assert.equal(login.response.status, 200, "test admin login should succeed");
    const setCookie = login.setCookies.find(value => value.startsWith(`${sessionCookieName}=`));
    assert.ok(setCookie, "login should issue a session cookie");
    await callback(request, setCookie.split(";", 1)[0]);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
}

test("real MongoDB: repeated seeding preserves legacy product IDs and stock states", async () => {
  await resetDisposableCollections();
  await Product.create([
    { name: "Legacy candle in stock", categoryId: 1, inStock: true },
    { name: "Legacy candle out of stock", categoryId: 1, inStock: false },
    { name: "Legacy resin", categoryId: 2, inStock: false },
    { name: "Legacy bracelet", categoryId: 3, inStock: true }
  ]);
  const originalProducts = await Product.find().sort({ name: 1 }).lean();
  await seedLegacyCategories();
  await seedLegacyCategories();
  const categories = await Category.find().sort({ id: 1 }).lean();
  assert.deepEqual(categories.map(({ id, name }) => ({ id, name })), [
    { id: 1, name: "Candles" }, { id: 2, name: "Resin Art" }, { id: 3, name: "Bracelets" }
  ]);
  assert.deepEqual(await Product.find().sort({ name: 1 }).lean(), originalProducts);
  assert.equal((await CategoryCounter.findById("category")).sequence, 3);
});

test("real MongoDB: counter starts above a higher category referenced only by an out-of-stock product", async () => {
  await resetDisposableCollections();
  await Product.create([
    { name: "Candle", categoryId: 1, inStock: true },
    { name: "Resin", categoryId: 2, inStock: false },
    { name: "Bracelet", categoryId: 3, inStock: true }
  ]);
  await seedLegacyCategories();
  await Category.create({ id: 12, name: "Special Editions", normalizedName: "special editions", image: null });
  await Product.create({ name: "Archived edition", categoryId: 12, inStock: false });
  await seedLegacyCategories();
  assert.equal((await CategoryCounter.findById("category")).sequence, 12);

  await withAdminApi(async (request, cookie) => {
    const created = await request("/api/categories", { method: "POST", cookie, body: { name: "Pottery" } });
    assert.equal(created.response.status, 201, created.text);
    assert.equal(JSON.parse(created.text).category.id, 13);
  });
});

test("real MongoDB: unmapped product category ID rejects before category or counter writes", async () => {
  await resetDisposableCollections();
  await Product.create({ name: "Unmapped legacy product", categoryId: 47, inStock: false });
  await assert.rejects(seedLegacyCategories(), /categoryId 47, but no category name is defined/);
  assert.equal(await Category.countDocuments(), 0);
  assert.equal(await CategoryCounter.countDocuments(), 0);
  assert.equal(await Product.countDocuments(), 1);
});

test("real MongoDB: conflicting IDs, names, and normalized-name data reject without writes", async () => {
  await resetDisposableCollections();
  await Category.collection.insertOne({ id: 1, name: "Resin Art", normalizedName: "resin art", image: null });
  await assert.rejects(seedLegacyCategories(), /Category ID 1 is already assigned/);
  assert.equal(await CategoryCounter.countDocuments(), 0);
  assert.equal(await Category.countDocuments(), 1);

  await resetDisposableCollections();
  await Category.collection.insertOne({ id: 9, name: "Candles", normalizedName: "candles", image: null });
  await assert.rejects(seedLegacyCategories(), /already uses ID 9/);
  assert.equal(await CategoryCounter.countDocuments(), 0);
  assert.equal(await Category.countDocuments(), 1);

  for (const category of [
    { id: 9, name: "Pottery" },
    { id: 9, name: "Pottery", normalizedName: "pottery bowls" }
  ]) {
    await resetDisposableCollections();
    await Category.collection.insertOne(category);
    await assert.rejects(seedLegacyCategories(), /missing or inconsistent normalized name/);
    assert.equal(await CategoryCounter.countDocuments(), 0);
    assert.equal(await Category.countDocuments(), 1);
  }
});

test("real MongoDB: duplicate legacy index values are detected before unique-index creation", async () => {
  await resetDisposableCollections();
  await Category.collection.drop();
  await Category.createCollection();
  await Category.collection.insertMany([
    { id: 8, name: "Pottery", normalizedName: "pottery", image: null },
    { id: 8, name: "Clay Art", normalizedName: "clay art", image: null }
  ]);
  await assert.rejects(seedLegacyCategories(), /Conflicting existing Category records use numeric ID 8/);
  assert.equal(await Category.countDocuments(), 2);
  assert.equal(await CategoryCounter.countDocuments(), 0);
  const indexes = await Category.collection.indexes();
  assert.equal(indexes.some(index => index.key.id === 1 && index.unique), false);
  await Category.deleteMany({});
  await Category.createIndexes();
});

test("real MongoDB: concurrent creation uses unique indexes and leaves a monotonic counter", async () => {
  await resetDisposableCollections();
  await Product.create([
    { name: "Candle", categoryId: 1, inStock: true },
    { name: "Resin", categoryId: 2, inStock: true },
    { name: "Bracelet", categoryId: 3, inStock: false }
  ]);
  await seedLegacyCategories();
  await assertCategoryUniqueIndexes();

  await withAdminApi(async (request, cookie) => {
    const add = name => request("/api/categories", { method: "POST", cookie, body: { name } });
    const distinctResults = await Promise.all([add("Macrame"), add("Pottery")]);
    assert.deepEqual(distinctResults.map(result => result.response.status), [201, 201]);
    const distinctIds = distinctResults.map(result => JSON.parse(result.text).category.id);
    assert.equal(new Set(distinctIds).size, 2);

    const equivalentResults = await Promise.all([add("Clay Art"), add(" clay art ")]);
    assert.deepEqual(equivalentResults.map(result => result.response.status).sort(), [201, 409]);
    assert.equal(await Category.countDocuments({ normalizedName: "clay art" }), 1);
  });

  const beforeReseed = (await CategoryCounter.findById("category")).sequence;
  await seedLegacyCategories();
  const afterReseed = (await CategoryCounter.findById("category")).sequence;
  assert.ok(afterReseed >= beforeReseed);
  assert.ok(afterReseed > Math.max(...(await Category.find().distinct("id"))));
});

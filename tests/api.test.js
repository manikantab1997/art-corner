const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { randomBytes, scryptSync } = require("node:crypto");
process.env.NODE_ENV = "test";
// Fixed, non-secret configuration for mocked UPI checkout tests.
process.env.UPI_ID = "checkout.test@upi";
process.env.UPI_PAYEE_NAME = "Art Corner Test";
const session = require("express-session");
const cookieSignature = require("cookie-signature");
const { app, Product, Order, Category, CategoryCounter, createApp, seedLegacyCategories, validateProductionConfig, sessionCookieName, hasSupportedImageSignature, generatePublicOrderReference, createOrderConfirmationToken, verifyOrderConfirmationToken, createUpiPaymentDetails, normalizeCustomerPhone, buildOrderTimeline, recoverStaleWhatsAppNotifications, verifySessionStoreReady, runStartupStage } = require("../server");

const originals = new Map();
function stub(target, name, value) {
  const key = `${target.modelName}.${name}`;
  if (!originals.has(key)) originals.set(key, { target, name, value: target[name] });
  target[name] = value;
}
function restore() {
  for (const { target, name, value } of originals.values()) target[name] = value;
  originals.clear();
}
function routeStack(method, routePath, target = app) {
  const layer = target.router.stack.find(item => item.route?.path === routePath && item.route.methods[method.toLowerCase()]);
  assert.ok(layer, `${method} ${routePath} route exists`);
  return layer.route.stack.map(item => item.handle);
}
async function invoke(handler, { params = {}, body = {}, file, reqSession = {}, headers = {} } = {}) {
  const result = { statusCode: 200, body: undefined, clearedCookie: null, ended: false };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(value) { result.body = value; return this; },
    clearCookie(name, options) { result.clearedCookie = { name, options }; return this; },
    end() { result.ended = true; return this; }
  };
  await handler({ params, body, file, session: reqSession, headers, get: name => headers[name.toLowerCase()] }, res);
  return result;
}
const testSalt = randomBytes(16);
const testPasswordHash = `scrypt$${testSalt.toString("hex")}$${scryptSync("test-only-password", testSalt, 64).toString("hex")}`;
class HttpTestSessionStore extends session.Store {
  constructor() { super(); this.sessions = new Map(); }
  get(id, callback) { callback(null, this.sessions.get(id) || null); }
  set(id, value, callback) { this.sessions.set(id, value); callback?.(null); }
  destroy(id, callback) { this.sessions.delete(id); callback?.(null); }
  touch(id, value, callback) { if (this.sessions.has(id)) this.sessions.set(id, value); callback?.(null); }
}
const authApp = createApp({
  sessionStore: new session.MemoryStore(),
  sessionSecret: "test-only-session-secret-with-enough-length",
  adminUsername: "test-admin",
  adminPasswordHash: testPasswordHash,
  production: false,
  storefrontOrigin: "http://localhost:3000"
});
const testOrigin = "https://storefront.example.test";
const testSessionSecret = "integration-test-session-secret-with-more-than-32-characters";
const testProductId = "64b64c0f1f1f1f1f1f1f1f1f";
const validCheckoutBody = (items = [{ _id: testProductId, qty: 2, name: "Client name", price: 1 }]) => ({
  customer: { name: "A Customer", phone: "9876543210", email: "customer@example.com", address: "Bengaluru delivery address" },
  items
});
const productFindResult = products => ({ lean: async () => products });
function makeCloudinaryMock({ fail = false } = {}) {
  const uploaded = [];
  const deleted = [];
  return {
    uploaded,
    deleted,
    uploader: {
      upload_stream(options, callback) {
        return { end(buffer) {
          if (fail) return callback(new Error("provider details must remain private"));
          const result = { secure_url: "https://images.example.test/art-corner/item.png", public_id: "art-corner/products/item" };
          uploaded.push({ options, buffer, result });
          callback(null, result);
        } };
      },
      async destroy(publicId, options) { deleted.push({ publicId, options }); return { result: "ok" }; }
    }
  };
}
const validPngFile = (name = "product.png") => ({
  originalname: name,
  mimetype: "image/png",
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
});
async function withHttpApp(callback, appOptions = {}) {
  const store = new HttpTestSessionStore();
  const httpApp = createApp({
    sessionStore: store,
    sessionSecret: testSessionSecret,
    adminUsername: "test-admin",
    adminPasswordHash: testPasswordHash,
    production: true,
    storefrontOrigin: testOrigin,
    ...appOptions
  });
  const server = httpApp.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(routePath, { method = "GET", origin = testOrigin, cookie, body, headers = {} } = {}) {
    const requestHeaders = { "X-Forwarded-Proto": "https", ...headers };
    if (origin !== null) requestHeaders.Origin = origin;
    if (cookie) requestHeaders.Cookie = cookie;
    if (headers.Host) {
      const target = new URL(`${baseUrl}${routePath}`);
      return new Promise((resolve, reject) => {
        const outgoing = http.request({
          hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
          method, headers: requestHeaders
        }, incoming => {
          const chunks = [];
          incoming.on("data", chunk => chunks.push(chunk));
          incoming.on("end", () => {
            const responseHeaders = incoming.headers;
            resolve({
              response: { status: incoming.statusCode, headers: { get: name => responseHeaders[name.toLowerCase()] || null } },
              setCookies: responseHeaders["set-cookie"] || [],
              text: Buffer.concat(chunks).toString("utf8")
            });
          });
        });
        outgoing.once("error", reject);
        outgoing.end(body);
      });
    }
    const response = await fetch(`${baseUrl}${routePath}`, { method, headers: requestHeaders, body });
    return { response, setCookies: response.headers.getSetCookie(), text: await response.text() };
  }
  try {
    await callback({ store, request });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const legacyCategoryFixtures = [
  { id: 1, name: "Candles", normalizedName: "candles", image: "/uploads/candle.jpg" },
  { id: 2, name: "Resin Art", normalizedName: "resin art", image: "/uploads/resin.jpg" },
  { id: 3, name: "Bracelets", normalizedName: "bracelets", image: "/uploads/bracelet.jpg" }
];
async function withCategoryMocks(callback, initialCategories = legacyCategoryFixtures, productCategoryIds = [1, 2, 3]) {
  const records = initialCategories.map(category => ({ ...category }));
  let sequence = Math.max(3, ...records.map(category => category.id));
  stub(Category, "find", function () {
    return {
      sort() { return this; },
      lean: async () => records.slice().sort((a, b) => a.id - b.id).map(category => ({ ...category }))
    };
  });
  stub(Category, "findOne", function (filter = {}) {
    let sortBy = null;
    const find = () => {
      const matches = records.filter(category => Object.entries(filter).every(([key, value]) => category[key] === value));
      if (sortBy) {
        const [key, direction] = Object.entries(sortBy)[0];
        matches.sort((a, b) => (a[key] - b[key]) * direction);
      }
      return matches[0] || null;
    };
    const query = {
      sort(value) { sortBy = value; return this; },
      select() { return this; },
      lean: async () => find() ? { ...find() } : null,
      then(resolve, reject) { return Promise.resolve(find() ? { ...find() } : null).then(resolve, reject); }
    };
    return query;
  });
  stub(Category, "exists", async filter => records.some(category => category.id === filter.id));
  stub(Category, "findOneAndUpdate", async (filter, update) => {
    const category = records.find(record => record.id === filter.id &&
      (filter.deleting?.$ne !== true || record.deleting !== true));
    if (!category) return null;
    if (update.$set?.normalizedName && records.some(record => record !== category && record.normalizedName === update.$set.normalizedName)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    Object.assign(category, update.$set || {});
    for (const [key, value] of Object.entries(update.$inc || {})) category[key] = (category[key] || 0) + value;
    category.pendingProductAssignments ??= 0;
    category.deleting ??= false;
    return { ...category };
  });
  stub(Category, "updateOne", async (filter, update) => {
    const category = records.find(record => record.id === filter.id &&
      (filter.deleting === undefined || record.deleting === filter.deleting) &&
      (filter.pendingProductAssignments?.$gt === undefined || (record.pendingProductAssignments || 0) > filter.pendingProductAssignments.$gt));
    if (!category && update.$setOnInsert) {
      records.push({ ...update.$setOnInsert, pendingProductAssignments: 0, deleting: false });
      return { acknowledged: true };
    }
    if (!category) return { matchedCount: 0 };
    Object.assign(category, update.$set || {});
    for (const [key, value] of Object.entries(update.$inc || {})) category[key] = (category[key] || 0) + value;
    return { matchedCount: 1 };
  });
  stub(Category, "deleteOne", async filter => {
    const index = records.findIndex(record => record.id === filter.id && record.deleting === true &&
      [null, 0].includes(record.pendingProductAssignments ?? null));
    if (index < 0) return { deletedCount: 0 };
    records.splice(index, 1);
    return { deletedCount: 1 };
  });
  stub(Product, "distinct", async field => {
    assert.equal(field, "categoryId");
    return productCategoryIds;
  });
  stub(Product, "exists", async filter => productCategoryIds.includes(filter.categoryId));
  stub(Category, "init", async () => {});
  stub(CategoryCounter, "findOneAndUpdate", async (filter, update) => {
    if (update.$max) sequence = Math.max(sequence, update.$max.sequence);
    if (update.$inc) sequence += update.$inc.sequence;
    if (filter.sequence?.$lt !== undefined && sequence >= filter.sequence.$lt) return null;
    return { sequence };
  });
  stub(Category.prototype, "save", async function () {
    const category = this.toObject();
    if (records.some(existing => existing.id === category.id || existing.normalizedName === category.normalizedName)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    records.push(category);
    return this;
  });
  try {
    await callback(records);
  } finally {
    restore();
  }
}
function sessionCookie(setCookies) {
  const header = setCookies.find(value => value.startsWith(`${sessionCookieName}=`));
  assert.ok(header, "response should set the session cookie");
  return header.split(";", 1)[0];
}
function sessionIdFromCookie(cookie) {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  assert.ok(value.startsWith("s:"));
  return value.slice(2, value.indexOf(".", 2));
}
function seedSession(store, sid, isAdmin = false) {
  return new Promise((resolve, reject) => store.set(sid, {
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/", secure: true, sameSite: "lax" },
    isAdmin
  }, error => error ? reject(error) : resolve()));
}
function signedSessionCookie(sid) {
  return `${sessionCookieName}=${encodeURIComponent(`s:${cookieSignature.sign(sid, testSessionSecret)}`)}`;
}
function checkoutBrowser({ search = "", cart = [{ _id: "p1", name: "Sample", price: 250, qty: 1 }], fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ orderId: "ORD-123e4567-e89b-42d3-a456-426614174000", publicReference: "AC-7K2P9", confirmationToken: "signed-test-token" }) }) } = {}) {
  const storage = new Map();
  if (cart !== undefined) storage.set("cart", JSON.stringify(cart));
  const nodes = {
    checkoutForm: { hidden: false, onsubmit: null, querySelector: () => ({ disabled: false }), reportValidity() { this.reported = true; } },
    checkoutFeedback: { textContent: "" },
    legacyOrderNotice: { hidden: true }, legacyOrderNoticeText: { textContent: "" },
    checkoutSummaryItems: uiElement("div"), checkoutSummaryTotal: { textContent: "" },
    placeOrderButton: { disabled: false, textContent: "Place Order" },
    name: { value: "A Customer", addEventListener() {}, setCustomValidity() {}, focus() {} },
    phone: { value: "9876543210", addEventListener() {}, setCustomValidity() {}, focus() {} },
    email: { value: "customer@example.com", addEventListener() {}, setCustomValidity() {}, focus() {} },
    whatsappOptIn: { checked: false },
    address: { value: "Bengaluru delivery address", addEventListener() {}, setCustomValidity() {}, focus() {} },
    nameError: { textContent: "" }, phoneError: { textContent: "" }, emailError: { textContent: "" }, addressError: { textContent: "" }
  };
  const window = { history: { back() {}, replaceState(_state, _title, url) { this.replacedUrl = url; } }, location: { search, href: "" } };
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    removeItem: key => storage.delete(key)
  };
  const document = { getElementById: id => nodes[id], createElement: tag => uiElement(tag) };
  const source = fs.readFileSync(path.join(__dirname, "../public/checkout.js"), "utf8");
  const sessionStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  };
  vm.runInNewContext(source, {
    document, window, localStorage, sessionStorage, fetch: fetchImpl, console, URLSearchParams,
    crypto: { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" }
  });
  return { nodes, window, storage, sessionStorage };
}
async function orderSuccessBrowser({ responseBody, clipboard = async () => {} }) {
  const ids = [
    "orderSuccessHeading", "orderSuccessMessage", "orderSuccessDetails", "orderSuccessCard", "orderSuccessMark",
    "upiPaymentPanel", "upiPaymentAmount", "upiPaymentReference", "upiQrImage", "upiQrStatus", "upiPayeeName",
    "upiIdValue", "copyUpiIdButton", "upiPayButton", "upiAppHelp", "upiPaymentUnavailable", "sharePaymentDetailsLink"
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, uiElement(id)]));
  nodes.orderSuccessDetails.hidden = true;
  nodes.upiPaymentPanel.hidden = true;
  nodes.upiQrImage.hidden = true;
  nodes.copyUpiIdButton.hidden = true;
  nodes.upiPayButton.hidden = true;
  nodes.upiPaymentUnavailable.hidden = true;
  const sessionStorage = { getItem: key => key === "artcorner.order.confirmation" ? JSON.stringify({ token: "test-confirmation-token", publicReference: "AC-7K2P9" }) : null };
  const document = { getElementById: id => nodes[id] || null, createElement: tag => uiElement(tag) };
  const fetchCalls = [];
  const source = fs.readFileSync(path.join(__dirname, "../public/order-success.js"), "utf8");
  vm.runInNewContext(source, {
    document, sessionStorage, URL,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, json: async () => responseBody };
    },
    navigator: { clipboard: { writeText: clipboard } }, console
  });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, fetchCalls };
}
async function cartBrowser({ cart = [], products = [{ _id: "p1", inStock: true }] } = {}) {
  const storage = new Map([...(cart === undefined ? [] : [["cart", JSON.stringify(cart)]])]);
  const nodes = { cart: uiElement("section"), subtotal: uiElement("strong"), total: uiElement("strong"), cartStatus: uiElement("p"), checkoutLink: uiElement("a") };
  const listeners = {};
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  };
  const window = { history: { back() {} }, addEventListener: (name, callback) => { listeners[name] = callback; }, dispatchEvent() {} };
  const document = { getElementById: id => nodes[id], createElement: tag => uiElement(tag) };
  const source = fs.readFileSync(path.join(__dirname, "../public/cart.js"), "utf8");
  vm.runInNewContext(source, { document, window, localStorage, fetch: async () => ({ ok: true, json: async () => products }), console, URL });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { nodes, storage, listeners };
}
function uiElement(tagName = "div") {
  return {
    tagName,
    children: [],
    handlers: {},
    attributes: {},
    className: "",
    style: {},
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      toggle(value, force) { const next = force === undefined ? !this.values.has(value) : force; next ? this.values.add(value) : this.values.delete(value); return next; },
      contains(value) { return this.values.has(value); }
    },
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    set innerHTML(value) { this._innerHTML = value; this.children = []; },
    get innerHTML() { return this._innerHTML || ""; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this._innerHTML = ""; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; },
    reset() { this.resetCalled = true; },
    focus() { this.focused = true; },
    remove() { this.removed = true; },
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || null; },
    querySelectorAll() { return this.children.flatMap(child => [child, ...(child.querySelectorAll ? child.querySelectorAll("") : [])]); }
  };
}
async function runBrowserScript(relativePath, { nodes = {}, queryNodes = {}, fetchImpl, search = "", requireAdminPage, confirmImpl = () => true, stored = {} } = {}) {
  const storage = new Map(Object.entries(stored));
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const window = { history: { back() {}, replaceState(_state, _title, url) { this.replacedUrl = url; } }, location: { search, href: "" }, addEventListener() {}, dispatchEvent() {} };
  const document = {
    getElementById: id => nodes[id] || null,
    querySelector: selector => queryNodes[selector] || null,
    createElement: tag => uiElement(tag),
    createTextNode: text => Object.assign(uiElement("#text"), { textContent: text }),
    body: uiElement("body"),
    activeElement: null,
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  vm.runInNewContext(source, {
    document, window: { ...window, confirm: confirmImpl }, localStorage, fetch: fetchImpl, console, URLSearchParams,
    URL, encodeURIComponent, requireAdminPage, confirm: confirmImpl, Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    FormData: class { append() {} }, alert() {}
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { window, nodes, storage, document };
}

test("GET /api/products queries only in-stock products", async () => {
  stub(Product, "find", async filter => {
    assert.deepEqual(filter, { inStock: true });
    return [{ _id: "p1", name: "Sample", image: "/uploads/candle.jpg", inStock: true }];
  });
  const handlers = routeStack("get", "/api/products");
  const response = await invoke(handlers.at(-1));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, [{ _id: "p1", name: "Sample", image: "/uploads/candle.jpg", inStock: true }]);
  restore();
});
test("POST /api/products returns a clear error for missing name and required fields", async () => {
  const response = await invoke(routeStack("post", "/api/products").at(-1));
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Product name is required/);
});
test("POST /api/products rejects missing image after validating product fields", async () => {
  const response = await invoke(routeStack("post", "/api/products").at(-1), { body: { name: "Sample item", price: "250", categoryId: "1" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "A product image is required");
});
test("GET /api/product/:id rejects malformed IDs before database access", async () => {
  const response = await invoke(routeStack("get", "/api/product/:id").at(-1), { params: { id: "not-an-object-id" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Invalid product ID");
});
test("PUT /api/products/:id rejects malformed IDs before database access", async () => {
  const response = await invoke(routeStack("put", "/api/products/:id").at(-1), { params: { id: "bad-id" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Invalid product ID");
});
test("PUT /api/orders/:id validates status before database access", async () => {
  const response = await invoke(routeStack("put", "/api/orders/:id").at(-1), { body: { status: "Unexpected" } });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Status must be/);
});
test("POST /api/orders returns a persisted order ID in a success response", async () => {
  const originalSave = Order.prototype.save;
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  let savedOrder;
  Product.find = filter => {
    assert.deepEqual(filter._id.$in, [testProductId]);
    return productFindResult([{ _id: testProductId, name: "Database candle", price: 125.5, inStock: true }]);
  };
  Order.findOne = filter => ({ select: async () => {
    assert.equal(filter.idempotencyKey, "123e4567-e89b-42d3-a456-426614174000");
    return null;
  } });
  Order.prototype.save = async function () { savedOrder = this; return this; };
  try {
    const submittedBody = validCheckoutBody();
    submittedBody.customer.isAdmin = true;
    submittedBody.total = 0;
    submittedBody.paymentStatus = "Paid";
    submittedBody.status = "Delivered";
    const response = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: submittedBody,
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 201);
    assert.match(response.body.orderId, /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(response.body.publicReference, /^AC-[A-HJ-NP-Z2-9]{5}$/);
    assert.match(response.body.confirmationToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(savedOrder.items, [{ productId: testProductId, name: "Database candle", price: 125.5, qty: 2, lineTotal: 251 }]);
    assert.equal(savedOrder.subtotal, 251);
    assert.equal(savedOrder.total, 251);
    assert.equal(savedOrder.currency, "INR");
    assert.equal(savedOrder.paymentAmount, 251);
    assert.equal(savedOrder.paymentStatus, "Pending");
    assert.equal(savedOrder.status, "Placed");
    assert.equal(savedOrder.customer.phone, "919876543210", "new orders store the canonical phone number");
    assert.equal(savedOrder.customerWhatsAppOptIn, false);
    assert.deepEqual(savedOrder.whatsappOutbox, []);
    assert.equal(savedOrder.customer.isAdmin, undefined);
    const missingKey = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: validCheckoutBody()
    });
    assert.equal(missingKey.statusCode, 400);
  } finally {
    Order.prototype.save = originalSave;
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
  }
});

test("customer phone normalization accepts Indian formats and explicit international numbers, rejecting invalid lengths", () => {
  for (const input of ["9876543210", "+91 98765 43210", "91-9876543210", "09876543210", "0091 09876543210", "+91 (0) 98765-43210"]) {
    assert.equal(normalizeCustomerPhone(input), "919876543210", input);
  }
  assert.equal(normalizeCustomerPhone("+1 (415) 555-2671"), "14155552671");
  assert.equal(normalizeCustomerPhone("14155552671"), "14155552671", "legacy unprefixed international country-code form remains searchable");
  for (const input of ["1234567", "987654321", "1234567890", "9198765432101234", "+91 12345 67890", "98abc6543210"]) {
    assert.equal(normalizeCustomerPhone(input), null, input);
  }
});

test("new order creation rejects invalid phone lengths before product lookup", async () => {
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  let productLookups = 0;
  Product.find = () => { productLookups++; return productFindResult([]); };
  Order.findOne = () => ({ select: async () => null });
  try {
    const invalid = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: { ...validCheckoutBody(), customer: { ...validCheckoutBody().customer, phone: "1234567" } },
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.error, /phone number/i);
    assert.equal(productLookups, 0);
  } finally {
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
  }
});

test("new payment orders require valid UPI configuration before product lookup or persistence", async () => {
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  const originalSave = Order.prototype.save;
  let productLookups = 0;
  let saves = 0;
  Product.find = () => { productLookups++; return productFindResult([]); };
  Order.findOne = () => ({ select: async () => null });
  Order.prototype.save = async function () { saves++; return this; };
  try {
    for (const upiEnv of [{}, { UPI_ID: "test@upi" }, { UPI_ID: "invalid-vpa", UPI_PAYEE_NAME: "Test" }]) {
      const paymentApp = createApp({ storefrontOrigin: "http://localhost:3000", upiEnv });
      const response = await invoke(routeStack("post", "/api/orders", paymentApp).at(-1), {
        body: validCheckoutBody(),
        headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
      });
      assert.equal(response.statusCode, 503);
      assert.match(response.body.error, /UPI payments are temporarily unavailable/i);
      assert.doesNotMatch(response.body.error, /test@upi|invalid-vpa|Test/);
    }
    assert.equal(productLookups, 0);
    assert.equal(saves, 0);
  } finally {
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
    Order.prototype.save = originalSave;
  }
});

test("idempotent checkout recovery does not depend on current UPI configuration", async () => {
  const originalOrderFindOne = Order.findOne;
  const body = validCheckoutBody();
  const requestHash = require("node:crypto").createHash("sha256").update(JSON.stringify(body)).digest("hex");
  Order.findOne = () => ({ select: async () => ({ orderId: "ORD-existing", publicReference: "AC-7K2P9", requestHash, subtotal: 25, total: 25 }) });
  try {
    const paymentApp = createApp({ storefrontOrigin: "http://localhost:3000", upiEnv: {} });
    const response = await invoke(routeStack("post", "/api/orders", paymentApp).at(-1), {
      body, headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.orderId, "ORD-existing");
    assert.equal(response.body.publicReference, "AC-7K2P9");
  } finally { Order.findOne = originalOrderFindOne; }
});

test("UPI VPA validation accepts different provider handles without relying on a fixed suffix", async () => {
  for (const upiId of ["maker@upi", "maker.name@okaxis", "maker_1@bank-handle", "1234567890@pay.example"]) {
    const payment = await createUpiPaymentDetails({ publicReference: "AC-7K2P9", paymentStatus: "Pending", paymentAmount: 25 }, {
      env: { UPI_ID: upiId, UPI_PAYEE_NAME: "Test Payee" }, qrCode: { toDataURL: async () => "data:image/png;base64,cXJjb2Rl" }
    });
    assert.equal(payment.upiId, upiId);
  }
});

test("zero-total UPI orders are rejected and never saved", async () => {
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  const originalSave = Order.prototype.save;
  let saves = 0;
  Order.findOne = () => ({ select: async () => null });
  Product.find = () => productFindResult([{ _id: testProductId, name: "Free sample", price: 0, inStock: true }]);
  Order.prototype.save = async function () { saves++; return this; };
  try {
    const response = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: validCheckoutBody([{ _id: testProductId, qty: 1 }]),
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /greater than ₹0\.00/i);
    assert.equal(saves, 0);
  } finally {
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
    Order.prototype.save = originalSave;
  }
});

test("POST /api/orders ignores client prices and rejects malformed, missing and out-of-stock products", async () => {
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  const originalSave = Order.prototype.save;
  let saveCount = 0;
  let lookupCount = 0;
  Order.findOne = () => ({ select: async () => null });
  Product.find = () => {
    lookupCount++;
    return productFindResult([{ _id: testProductId, name: "Trusted name", price: 40, inStock: true }]);
  };
  Order.prototype.save = async function () { saveCount++; return this; };
  const handler = routeStack("post", "/api/orders").at(-1);
  const headers = { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" };
  try {
    const manipulated = await invoke(handler, { body: validCheckoutBody([{ _id: testProductId, qty: 1, name: "Injected name", price: 0.01 }]), headers });
    assert.equal(manipulated.statusCode, 201);
    assert.equal(manipulated.body.total, 40);

    const invalidId = await invoke(handler, { body: validCheckoutBody([{ _id: "not-an-id", qty: 1 }]), headers });
    assert.equal(invalidId.statusCode, 400);
    assert.match(invalidId.body.error, /invalid product ID/i);
    assert.equal(lookupCount, 1, "invalid IDs are rejected before querying products");

    const invalidQuantity = await invoke(handler, { body: validCheckoutBody([{ _id: testProductId, qty: 1.5 }]), headers });
    assert.equal(invalidQuantity.statusCode, 400);
    assert.match(invalidQuantity.body.error, /whole numbers/i);

    Product.find = () => productFindResult([]);
    const missing = await invoke(handler, { body: validCheckoutBody([{ _id: testProductId, qty: 1 }]), headers });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.body.error, /no longer available/i);

    Product.find = () => productFindResult([{ _id: testProductId, name: "Unavailable candle", price: 40, inStock: false }]);
    const outOfStock = await invoke(handler, { body: validCheckoutBody([{ _id: testProductId, qty: 1 }]), headers });
    assert.equal(outOfStock.statusCode, 409);
    assert.match(outOfStock.body.error, /out of stock/i);
    assert.equal(saveCount, 1, "only the valid order was persisted");
  } finally {
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
    Order.prototype.save = originalSave;
  }
});

test("new payment fields remain absent on legacy orders and UPI config is centralized and optional", () => {
  const legacy = Order.hydrate({ orderId: "ORD-legacy", status: "Shipped", items: [] });
  assert.equal(legacy.paymentStatus, undefined);
  assert.equal(legacy.paymentAmount, undefined);
  const { getUpiPaymentConfig } = require("../server");
  assert.equal(getUpiPaymentConfig({}), null);
  assert.deepEqual(getUpiPaymentConfig({ UPI_ID: "artcorner@bank", UPI_PAYEE_NAME: "Art Corner Bengaluru" }), {
    upiId: "artcorner@bank", payeeName: "Art Corner Bengaluru", currency: "INR"
  });
  assert.throws(() => getUpiPaymentConfig({ UPI_ID: "artcorner@bank" }), /incomplete or invalid/);
});
test("WhatsApp Cloud API uses an approved template with order details and does not expose provider errors", async () => {
  const { getWhatsAppConfig, buildWhatsAppOrderPayload, sendWhatsAppOrderNotification } = require("../server");
  const env = {
    WHATSAPP_ACCESS_TOKEN: "test-token-never-logged", WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_TEMPLATE_NAME: "new_order_notice"
  };
  const config = getWhatsAppConfig(env);
  const payload = buildWhatsAppOrderPayload({
    _id: "order-ref", orderId: "ORD-test", total: 420, items: [{ name: "Candle", price: 250, qty: 2 }]
  }, config);
  assert.deepEqual(payload.template.components[0].parameters.map(parameter => parameter.text), ["ORD-test", "Candle × 2", "420.00", "order-ref"]);
  assert.equal(buildWhatsAppOrderPayload({ orderId: "ORD-legacy", items: [{ name: "Candle", price: 250, qty: 2 }] }, config).template.components[0].parameters[2].text, "500.00");
  let requestOptions;
  const sent = await sendWhatsAppOrderNotification({
    _id: "order-ref", orderId: "ORD-test", total: 420, items: [{ name: "Candle", price: 250, qty: 2 }]
  }, { env, fetchImpl: async (url, options) => {
    assert.match(url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/1234567890\/messages$/);
    requestOptions = options;
    return { ok: true, json: async () => ({ messages: [{ id: "meta-message-id" }] }) };
  } });
  assert.equal(sent.status, "sent");
  assert.equal(sent.messageId, "meta-message-id");
  assert.match(requestOptions.headers.Authorization, /^Bearer /);
  const failed = await sendWhatsAppOrderNotification({}, { env, fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: "provider secret details" } }) }) });
  assert.deepEqual(failed, { status: "failed" });
  const ambiguous = await sendWhatsAppOrderNotification({}, { env, fetchImpl: async () => { throw new Error("private network details"); } });
  assert.deepEqual(ambiguous, { status: "unknown" });
  assert.equal(getWhatsAppConfig({}), null);
  assert.throws(() => getWhatsAppConfig({ ...env, WHATSAPP_TEMPLATE_NAME: undefined }), /incomplete/);
});

test("order persistence queues WhatsApp after save without synchronously sending", async () => {
  let saved = false;
  const originalSave = Order.prototype.save;
  const originalFindOne = Order.findOne;
  const originalProductFind = Product.find;
  let persistedOrder;
  Order.prototype.save = async function () { saved = true; this._id = "saved-order-ref"; persistedOrder = this; return this; };
  Order.findOne = filter => filter.idempotencyKey
    ? { select: async () => null }
    : Promise.resolve(persistedOrder);
  Product.find = () => productFindResult([{ _id: testProductId, name: "Database Sample", price: 10, inStock: true }]);
  const configuredEnv = {
    WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_TEMPLATE_NAME: "new_order_notice"
  };
  try {
    const testOrderApp = createApp({
      storefrontOrigin: "http://localhost:3000", whatsappEnv: configuredEnv,
      whatsappFetch: async () => { throw new Error("queue must not call provider during checkout"); }
    });
    const handler = routeStack("post", "/api/orders", testOrderApp).at(-1);
    const response = await invoke(handler, {
      body: { ...validCheckoutBody([{ _id: testProductId, qty: 1 }]), whatsappOptIn: true },
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 201);
    assert.match(response.body.orderId, /^ORD-/);
    assert.equal(saved, true);
    assert.equal(persistedOrder.whatsappNotificationStatus, "pending");
    assert.equal(persistedOrder.customerWhatsAppOptIn, true);
    assert.equal(persistedOrder.whatsappOutbox.length, 1);
    assert.equal(persistedOrder.whatsappOutbox[0].type, "customer_order");
  } finally {
    Order.prototype.save = originalSave;
    Order.findOne = originalFindOne;
    Product.find = originalProductFind;
  }
});

test("customer WhatsApp templates use the trusted amount and an encoded click-to-chat payment request", () => {
  const { getCustomerWhatsAppConfig, buildCustomerWhatsAppPayload, buildWhatsAppClickToChat } = require("../server");
  const env = {
    WHATSAPP_ACCESS_TOKEN: "mock-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_BUSINESS_RECIPIENT: "919380125087",
    WHATSAPP_CUSTOMER_ORDER_TEMPLATE_NAME: "customer_order_confirmation",
    WHATSAPP_CUSTOMER_PAYMENT_TEMPLATE_NAME: "customer_payment_success",
    WHATSAPP_CUSTOMER_FULFILMENT_TEMPLATE_NAME: "customer_fulfilment_update"
  };
  const config = getCustomerWhatsAppConfig(env);
  const order = { orderId: "ORD-internal", publicReference: "AC-7K2P9", paymentAmount: 325.5, total: 999, status: "Placed", customer: { name: "A Customer", phone: "+91 98765 43210" } };
  const payload = buildCustomerWhatsAppPayload(order, { type: "customer_order" }, config);
  assert.equal(payload.to, "919876543210");
  assert.deepEqual(payload.template.components[0].parameters.map(value => value.text), ["A Customer", "AC-7K2P9", "325.50", buildWhatsAppClickToChat(order, "919380125087")]);
  const share = new URL(buildWhatsAppClickToChat(order, "919380125087"));
  assert.equal(share.hostname, "wa.me");
  assert.match(share.searchParams.get("text"), /AC-7K2P9/);
  assert.match(share.searchParams.get("text"), /₹325\.50/);
  assert.match(share.searchParams.get("text"), /UTR/);
  assert.match(share.searchParams.get("text"), /screenshot/);
  assert.equal(getCustomerWhatsAppConfig({}), null);
});
test("customer WhatsApp delivery failures are recorded without changing payment state", async () => {
  const { processWhatsAppOutboxEvent } = require("../server");
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalUpdateOne = Order.updateOne;
  let persistedNotificationStatus;
  let sendCount = 0;
  const order = {
    orderId: "ORD-queue", publicReference: "AC-7K2P9", paymentStatus: "Paid", paymentAmount: 123.45,
    customerWhatsAppOptIn: true, status: "Preparing", customer: { name: "Customer", phone: "9876543210" },
    whatsappOutbox: [{ key: "event-1", type: "customer_payment_success", status: "sending" }]
  };
  Order.findOneAndUpdate = async (_filter, _update) => {
    const retryStates = _filter.whatsappOutbox.$elemMatch.status.$in;
    if (sendCount > 0 && !retryStates.includes("failed")) return null;
    sendCount++;
    return order;
  };
  Order.updateOne = async (_filter, update) => { persistedNotificationStatus = update.$set["whatsappOutbox.$.status"]; return { matchedCount: 1, modifiedCount: 1 }; };
  try {
    const outcome = await processWhatsAppOutboxEvent("ORD-queue", "event-1", {
      env: { WHATSAPP_ACCESS_TOKEN: "mock", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_CUSTOMER_PAYMENT_TEMPLATE_NAME: "payment_success" },
      fetchImpl: async () => ({ ok: false, status: 400 })
    });
    assert.deepEqual(outcome, { status: "failed" });
    assert.equal(persistedNotificationStatus, "failed");
    assert.equal(order.paymentStatus, "Paid");
    const retried = await processWhatsAppOutboxEvent("ORD-queue", "event-1", {
      retry: true,
      env: { WHATSAPP_ACCESS_TOKEN: "mock", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_CUSTOMER_PAYMENT_TEMPLATE_NAME: "payment_success" },
      fetchImpl: async () => ({ ok: true, json: async () => ({ messages: [{ id: "test-message" }] }) })
    });
    assert.equal(retried.status, "sent");
    assert.equal(persistedNotificationStatus, "sent");
    const duplicate = await processWhatsAppOutboxEvent("ORD-queue", "event-1", {
      env: { WHATSAPP_ACCESS_TOKEN: "mock", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_CUSTOMER_PAYMENT_TEMPLATE_NAME: "payment_success" },
      fetchImpl: async () => { throw new Error("must not resend sent event"); }
    });
    assert.equal(duplicate.status, "not_retryable");
    assert.equal(sendCount, 2);
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.updateOne = originalUpdateOne;
  }
});

test("stale sending notifications become unknown for manual reconciliation and are not automatically retried", async () => {
  const originalUpdateMany = Order.updateMany;
  const updates = [];
  Order.updateMany = async (...args) => { updates.push(args); return { modifiedCount: 1 }; };
  try {
    await recoverStaleWhatsAppNotifications(new Date("2026-11-08T12:00:00.000Z"));
    assert.equal(updates.length, 2);
    const expectedCutoff = new Date("2026-11-08T11:55:00.000Z");
    assert.deepEqual(updates[0][0], { whatsappNotificationStatus: "sending", whatsappNotificationAttemptedAt: { $lt: expectedCutoff } });
    assert.deepEqual(updates[0][1], { $set: { whatsappNotificationStatus: "unknown" } });
    assert.deepEqual(updates[1][0], { whatsappOutbox: { $elemMatch: { status: "sending", attemptedAt: { $lt: expectedCutoff } } } });
    assert.deepEqual(updates[1][1], { $set: { "whatsappOutbox.$[event].status": "unknown" } });
    assert.deepEqual(updates[1][2].arrayFilters, [{ "event.status": "sending", "event.attemptedAt": { $lt: expectedCutoff } }]);
  } finally { Order.updateMany = originalUpdateMany; }
});

test("concurrent notification workers can claim an opted-in outbox event only once", async () => {
  const { processWhatsAppOutboxEvent } = require("../server");
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalUpdateOne = Order.updateOne;
  let status = "pending";
  let sends = 0;
  const order = { orderId: "ORD-race", publicReference: "AC-7K2P9", paymentStatus: "Pending", paymentAmount: 20, total: 20,
    customerWhatsAppOptIn: true, customer: { name: "Customer", phone: "919876543210" },
    whatsappOutbox: [{ key: "event-race", type: "customer_order", status: "sending" }] };
  Order.findOneAndUpdate = async filter => {
    const allowed = filter.whatsappOutbox.$elemMatch.status.$in;
    if (!allowed.includes(status)) return null;
    status = "sending";
    return order;
  };
  Order.updateOne = async (_filter, update) => {
    status = update.$set["whatsappOutbox.$.status"];
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const env = { WHATSAPP_ACCESS_TOKEN: "mock-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_BUSINESS_RECIPIENT: "919380125087", WHATSAPP_CUSTOMER_ORDER_TEMPLATE_NAME: "customer_order" };
  try {
    const results = await Promise.all([1, 2].map(() => processWhatsAppOutboxEvent("ORD-race", "event-race", {
      env, fetchImpl: async () => { sends++; return { ok: true, json: async () => ({ messages: [{ id: "mock-message" }] }) }; }
    })));
    assert.equal(sends, 1);
    assert.equal(results.filter(result => result.status === "sent").length, 1);
    assert.equal(results.filter(result => result.status === "not_retryable").length, 1);
    assert.equal(status, "sent");
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.updateOne = originalUpdateOne;
  }
});

test("customer outbox reconciliation requires explicit confirmation and never retries an uncertain send automatically", async () => {
  const originalUpdateOne = Order.updateOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let updateCount = 0;
  Order.updateOne = async () => { updateCount++; return { matchedCount: 1, modifiedCount: 1 }; };
  Order.findOneAndUpdate = async () => null;
  try {
    const notificationApp = createApp({ storefrontOrigin: "http://localhost:3000", whatsappEnv: {} });
    const confirmSent = routeStack("post", "/api/admin/orders/:id/notifications/:key/confirm-sent", notificationApp).at(-1);
    assert.equal((await invoke(confirmSent, { params: { id: "ORD-1", key: "evt-1" }, body: {} })).statusCode, 400);
    assert.equal((await invoke(confirmSent, { params: { id: "ORD-1", key: "evt-1" }, body: { confirmed: true } })).statusCode, 200);
    const retryUnsent = routeStack("post", "/api/admin/orders/:id/notifications/:key/confirm-not-sent-retry", notificationApp).at(-1);
    assert.equal((await invoke(retryUnsent, { params: { id: "ORD-1", key: "evt-1" }, body: {} })).statusCode, 400);
    assert.equal((await invoke(retryUnsent, { params: { id: "ORD-1", key: "evt-1" }, body: { confirmedNotSent: true } })).statusCode, 200);
    assert.equal(updateCount, 2, "one sent reconciliation and one mark-failed step; no blind send occurs when the event cannot be claimed");
  } finally {
    Order.updateOne = originalUpdateOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("admin payment verification atomically records UTR, marks Paid and starts fulfilment once", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalExists = Order.exists;
  let updateCall = 0;
  let captured;
  Order.findOne = () => ({ select: async () => ({ customerWhatsAppOptIn: true, paymentStatus: "Pending" }) });
  Order.findOneAndUpdate = async (filter, update) => {
    captured = { filter, update };
    updateCall++;
    return updateCall === 1 ? { orderId: "ORD-internal", paymentStatus: "Paid", status: "Preparing", paymentVerifiedAt: new Date(), paymentVerifiedBy: "admin" } : null;
  };
  Order.exists = async () => true;
  try {
    const handler = routeStack("put", "/api/admin/orders/:id/payment-verification").at(-1);
    const first = await invoke(handler, { params: { id: "ORD-internal" }, body: { action: "verify", paymentReference: " UTR-123 " } });
    assert.equal(first.statusCode, 200);
    assert.equal(captured.filter.paymentStatus.$in.includes("Pending"), true);
    assert.equal(captured.update.$set.paymentStatus, "Paid");
    assert.equal(captured.update.$set.status, "Preparing");
    assert.equal(captured.update.$set.paymentVerifiedBy, "admin");
    assert.equal(captured.update.$set.paymentReference, "UTR-123");
    assert.equal(captured.update.$push.whatsappOutbox.type, "customer_payment_success");
    const duplicate = await invoke(handler, { params: { id: "ORD-internal" }, body: { action: "verify" } });
    assert.equal(duplicate.statusCode, 409);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.exists = originalExists;
  }
});

test("payment mismatch does not mark paid and legacy orders remain ineligible", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalExists = Order.exists;
  let update;
  Order.findOne = () => ({ select: async () => ({ customerWhatsAppOptIn: false, paymentStatus: "Pending" }) });
  Order.findOneAndUpdate = async (_filter, value) => { update = value; return { orderId: "ORD-pending", paymentStatus: "Failed / Mismatch", status: "Placed" }; };
  Order.exists = async () => true;
  try {
    const handler = routeStack("put", "/api/admin/orders/:id/payment-verification").at(-1);
    const recorded = await invoke(handler, { params: { id: "ORD-pending" }, body: { action: "record_reference", paymentReference: "UTR-RECORDED" } });
    assert.equal(recorded.statusCode, 200);
    assert.equal(update.$set.paymentReference, "UTR-RECORDED");
    assert.equal(update.$set.paymentStatus, "Verification Pending");
    const mismatch = await invoke(handler, { params: { id: "ORD-pending" }, body: { action: "mismatch", paymentReference: "UTR-BAD" } });
    assert.equal(mismatch.statusCode, 200);
    assert.equal(update.$set.paymentStatus, "Failed / Mismatch");
    assert.equal(update.$set.status, undefined);
    assert.equal(update.$push, undefined);
    Order.findOne = () => ({ select: async () => ({ customerWhatsAppOptIn: undefined, paymentStatus: undefined }) });
    Order.findOneAndUpdate = async () => null;
    const legacy = await invoke(handler, { params: { id: "ORD-legacy" }, body: { action: "verify" } });
    assert.equal(legacy.statusCode, 409);
    assert.match(legacy.body.error, /legacy/);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.exists = originalExists;
  }
});

test("fulfilment status changes are limited to valid transitions and queue only changed opted-in statuses", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let current = { status: "Preparing", paymentStatus: "Paid", customerWhatsAppOptIn: true };
  let captured;
  Order.findOne = () => ({ select: async () => ({ ...current }) });
  Order.findOneAndUpdate = async (filter, update) => { captured = { filter, update }; return { orderId: "ORD-1", status: update.$set.status }; };
  try {
    const handler = routeStack("put", "/api/orders/:id").at(-1);
    const invalid = await invoke(handler, { params: { id: "ORD-1" }, body: { status: "Unknown" } });
    assert.equal(invalid.statusCode, 400);
    const changed = await invoke(handler, { params: { id: "ORD-1" }, body: { status: "Shipped" } });
    assert.equal(changed.statusCode, 200);
    assert.equal(captured.update.$set.status, "Shipped");
    assert.equal(captured.update.$push.whatsappOutbox.type, "customer_fulfilment");
    current = { status: "Preparing", paymentStatus: "Pending", customerWhatsAppOptIn: true };
    const unpaid = await invoke(handler, { params: { id: "ORD-1" }, body: { status: "Shipped" } });
    assert.equal(unpaid.statusCode, 409);
    current = { status: "Shipped", paymentStatus: "Paid", customerWhatsAppOptIn: false };
    captured = undefined;
    await invoke(handler, { params: { id: "ORD-1" }, body: { status: "Shipped" } });
    assert.equal(captured, undefined, "unchanged status does not write or enqueue a duplicate message");
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
test("checkout idempotency returns the existing order without sending a second notification", async () => {
  const originalSave = Order.prototype.save;
  const originalFindOne = Order.findOne;
  const originalProductFind = Product.find;
  const savedPayload = validCheckoutBody([{ _id: testProductId, name: "Sample", price: 10, qty: 1 }]);
  const requestHash = require("node:crypto").createHash("sha256").update(JSON.stringify(savedPayload)).digest("hex");
  let existingAvailable = false;
  Order.prototype.save = async function () { existingAvailable = true; const error = new Error("duplicate key"); error.code = 11000; throw error; };
  Product.find = () => productFindResult([{ _id: testProductId, name: "Database Sample", price: 10, inStock: true }]);
  let lookupFilter;
  Order.findOne = filter => {
    lookupFilter = filter;
    return { select: async () => existingAvailable ? ({ orderId: "ORD-existing", requestHash }) : null };
  };
  try {
    const response = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: savedPayload, headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.orderId, "ORD-existing");
    assert.equal(response.body.publicReference, "ORD-existing");
    assert.equal(typeof response.body.confirmationToken, "string");
    assert.equal(lookupFilter.idempotencyKey, "123e4567-e89b-42d3-a456-426614174000");
    const conflict = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: { ...savedPayload, items: [{ _id: testProductId, name: "Changed item", price: 10, qty: 1 }] },
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(conflict.statusCode, 409);
  } finally {
    Order.prototype.save = originalSave;
    Order.findOne = originalFindOne;
    Product.find = originalProductFind;
  }
});

test("product customization defaults off and admin can persist an explicit setting", async () => {
  assert.equal(new Product().customizationEnabled, false);
  const originalFindById = Product.findById;
  const product = { customizationEnabled: false, save: async function () { this.saved = true; return this; } };
  Product.findById = async () => product;
  try {
    const response = await invoke(routeStack("put", "/api/products/:id").at(-1), {
      params: { id: "507f1f77bcf86cd799439011" }, body: { customizationEnabled: true }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(product.customizationEnabled, true);
    assert.equal(product.saved, true);
    const invalid = await invoke(routeStack("put", "/api/products/:id").at(-1), {
      params: { id: "507f1f77bcf86cd799439011" }, body: { customizationEnabled: "true" }
    });
    assert.equal(invalid.statusCode, 400);
  } finally { Product.findById = originalFindById; }
});

test("product customization links are conditional and use the configured business profiles", async () => {
  const enabledNodes = { product: uiElement("div"), addToCart: uiElement("button") };
  await runBrowserScript("public/product.js", {
    nodes: enabledNodes, search: "?id=p1",
    fetchImpl: async () => ({ ok: true, json: async () => ({ _id: "p1", name: "Candle & Rose", price: 20, inStock: true, customizationEnabled: true }) })
  });
  const section = enabledNodes.product.children.find(child => child.className === "product-customization");
  assert.ok(section, "enabled products show customization actions");
  const links = section.children[2].children;
  assert.equal(links[0].href, `https://wa.me/919380125087?text=${encodeURIComponent("Hi, I'd like to ask about customizing Candle & Rose. Could you share the available options?")}`);
  assert.equal(links[1].href, "https://www.instagram.com/art_corner_blr/");
  for (const link of links) {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.ok(link.attributes["aria-label"]);
  }
  const disabledNodes = { product: uiElement("div"), addToCart: uiElement("button") };
  await runBrowserScript("public/product.js", {
    nodes: disabledNodes, search: "?id=p2",
    fetchImpl: async () => ({ ok: true, json: async () => ({ _id: "p2", name: "Ordinary", price: 20, inStock: true, customizationEnabled: false }) })
  });
  assert.equal(disabledNodes.product.children.some(child => child.className === "product-customization"), false);
});

test("public footer uses the exact business profiles with accessible external links", () => {
  const footer = fs.readFileSync(path.join(__dirname, "../public/components/footer.html"), "utf8");
  assert.match(footer, /https:\/\/www\.instagram\.com\/art_corner_blr\//);
  assert.match(footer, /https:\/\/wa\.me\/919380125087/);
  assert.doesNotMatch(footer, /wa\.me\/919999999999|href="https?:\/\/instagram\.com"/);
  assert.match(footer, /target="_blank" rel="noopener noreferrer" aria-label=/);
});
test("checkout clears cart only after a confirmed response and redirects to the dedicated confirmation page", async () => {
  let submittedBody;
  const browser = checkoutBrowser({ fetchImpl: async (_url, options) => {
    submittedBody = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ orderId: "ORD-123e4567-e89b-42d3-a456-426614174000", publicReference: "AC-7K2P9", confirmationToken: "signed-test-token" }) };
  } });
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(browser.storage.has("cart"), false);
  assert.equal(browser.window.location.href, "order-success.html");
  assert.ok(browser.sessionStorage.getItem("artcorner.order.confirmation"));
  assert.deepEqual(submittedBody.items, [{ _id: "p1", qty: 1 }]);
  assert.equal("price" in submittedBody.items[0], false);
  assert.equal("name" in submittedBody.items[0], false);
});
test("checkout failure preserves cart and shows an error", async () => {
  const browser = checkoutBrowser({ fetchImpl: async () => ({ ok: false, json: async () => ({ error: "Order save failed" }) }) });
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(browser.storage.has("cart"), true);
  assert.match(browser.nodes.checkoutFeedback.textContent, /Order save failed/);
});
test("checkout sends WhatsApp consent only when the customer explicitly opts in", async () => {
  let requestBody;
  const browser = checkoutBrowser({ fetchImpl: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ orderId: "ORD-123e4567-e89b-42d3-a456-426614174000", publicReference: "AC-7K2P9", confirmationToken: "signed-test-token" }) };
  } });
  browser.nodes.whatsappOptIn.checked = true;
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(requestBody.whatsappOptIn, true);
});
test("cart renders Cloudinary images, totals quantities, and persists quantity/removal controls", async () => {
  const browser = await cartBrowser({
    cart: [{ _id: "p1", name: "Resin tray", price: 125.5, qty: 2, image: "https://res.cloudinary.com/example/image/upload/tray.jpg" }]
  });
  const card = browser.nodes.cart.children[0];
  const image = card.children[0].children[0];
  assert.equal(image.src, "https://res.cloudinary.com/example/image/upload/tray.jpg");
  assert.equal(browser.nodes.subtotal.textContent, "₹251.00");
  const controls = card.children[2];
  controls.children[1].children[2].handlers.click();
  assert.equal(JSON.parse(browser.storage.get("cart"))[0].qty, 3);
  browser.nodes.cart.children[0].children[2].children[2].handlers.click();
  assert.deepEqual(JSON.parse(browser.storage.get("cart")), []);
  assert.equal(browser.nodes.cart.children[0].className, "cart-empty-state");
});
test("cart shows an empty state and keeps checkout hidden when empty", async () => {
  const browser = await cartBrowser({ cart: [] });
  assert.equal(browser.nodes.cart.children[0].className, "cart-empty-state");
  assert.equal(browser.nodes.checkoutLink.hidden, true);
  assert.equal(browser.nodes.total.textContent, "₹0.00");
});
test("shared navigation synchronizes cart badges and supports accessible mobile drawer controls", () => {
  const badgeLink = uiElement("a");
  const badge = uiElement("span");
  badge.closest = () => badgeLink;
  const floatingBadge = uiElement("span");
  const floatingCart = uiElement("a");
  floatingBadge.closest = () => floatingCart;
  floatingCart.href = "cart.html";
  const backLink = uiElement("a");
  const footer = uiElement("footer");
  let footerObserver;
  const toggle = uiElement("button");
  const close = uiElement("button");
  const backdrop = uiElement("button");
  backdrop.hidden = true;
  const menu = uiElement("aside");
  menu.removeAttribute = name => { delete menu.attributes[name]; };
  const homeLink = uiElement("a");
  homeLink.href = "index.html";
  const finalLink = uiElement("a");
  finalLink.href = "login.html";
  menu.querySelectorAll = selector => selector.includes("a[href]") ? [homeLink, finalLink] : [homeLink, finalLink, close];
  const root = { querySelector: selector => ({
    "#mobileMenuToggle": toggle, "#mobileMenu": menu, "#mobileMenuClose": close, "#mobileMenuBackdrop": backdrop
  })[selector] || null };
  const keyHandlers = {};
  const windowHandlers = {};
  const document = {
    body: { classList: uiElement().classList }, activeElement: null,
    querySelectorAll: selector => selector === "[data-cart-count]" ? [badge, floatingBadge] : [],
    querySelector: selector => selector === "[data-floating-cart]" ? floatingCart : selector === "#footer-container .footer" ? footer : null,
    addEventListener: (name, handler) => { keyHandlers[name] = handler; },
    getElementById: () => null
  };
  const storage = new Map([["cart", JSON.stringify([{ qty: 2 }, { qty: 1 }])]]);
  const window = { location: { pathname: "/products.html" }, addEventListener: (name, handler) => { windowHandlers[name] = handler; }, dispatchEvent() {} };
  const source = fs.readFileSync(path.join(__dirname, "../public/js/common.js"), "utf8");
  const context = vm.createContext({ document, window, localStorage: { getItem: key => storage.get(key) }, Event: class {},
    IntersectionObserver: class { constructor(callback) { this.callback = callback; footerObserver = this; } observe(target) { this.target = target; } },
    fetch: async () => ({ ok: true, text: async () => "" }), console });
  vm.runInContext(source, context);
  context.updateCartBadges();
  assert.equal(badge.textContent, "3");
  assert.equal(badge.hidden, false);
  assert.equal(badgeLink.attributes["aria-label"], "Cart, 3 items");
  assert.equal(floatingBadge.textContent, "3");
  assert.equal(floatingCart.hidden, false);
  assert.equal(floatingCart.attributes["aria-label"], "Cart, 3 items");
  storage.set("cart", JSON.stringify([{ qty: 1 }]));
  context.announceCartUpdated();
  assert.equal(floatingBadge.textContent, "1");
  storage.set("cart", JSON.stringify([{ qty: 2 }]));
  context.announceCartUpdated();
  assert.equal(floatingBadge.textContent, "2");
  assert.equal(floatingCart.href, "cart.html", "floating cart navigates to the existing cart page");
  storage.set("cart", "[]");
  windowHandlers.storage({ key: "cart" });
  assert.equal(floatingCart.hidden, true, "floating cart hides when the shared cart is empty");
  storage.set("cart", JSON.stringify([{ qty: 1 }]));
  window.location.pathname = "/products.html";
  context.updateCartBadges();
  context.observeFooterForFloatingCart();
  assert.equal(footerObserver.target, footer);
  footerObserver.callback([{ isIntersecting: true }]);
  assert.equal(floatingCart.hidden, true, "floating cart hides while the footer is visible");
  footerObserver.callback([{ isIntersecting: false }]);
  assert.equal(floatingCart.hidden, false, "floating cart returns after the footer leaves view");
  window.location.pathname = "/cart.html";
  context.updateCartBadges();
  assert.equal(floatingCart.hidden, true, "floating cart stays out of the way on the cart page");
  window.location.pathname = "/checkout.html";
  context.updateCartBadges();
  assert.equal(floatingCart.hidden, true, "floating cart stays out of the way on checkout");
  window.location.pathname = "/admin.html";
  context.updateCartBadges();
  assert.equal(floatingCart.hidden, true, "floating cart stays out of the way in admin pages");

  const contextualRoot = { querySelector: selector => selector === "[data-contextual-back]" ? backLink : null };
  window.location.pathname = "/product.html";
  context.setupContextualBackLink(contextualRoot);
  assert.equal(backLink.href, "products.html");
  assert.equal(backLink.textContent, "← Back to products");
  window.location.pathname = "/cart.html";
  context.setupContextualBackLink(contextualRoot);
  assert.equal(backLink.href, "products.html");
  assert.equal(backLink.textContent, "← Continue shopping");
  window.location.pathname = "/checkout.html";
  context.setupContextualBackLink(contextualRoot);
  assert.equal(backLink.href, "cart.html");
  assert.equal(backLink.textContent, "← Back to cart");
  window.location.pathname = "/index.html";
  context.setupContextualBackLink(contextualRoot);
  assert.equal(backLink.hidden, true, "homepage has no contextual back link");
  context.setupMobileNavigation(root);
  toggle.handlers.click();
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(menu.attributes["aria-hidden"], "false");
  assert.equal(document.body.classList.contains("mobile-menu-open"), true);
  let prevented = false;
  keyHandlers.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(backdrop.hidden, true);
  assert.equal(typeof windowHandlers.storage, "function");
});
test("bottom navigation markup and its reserved page spacing are removed", () => {
  const htmlFiles = fs.readdirSync(path.join(__dirname, "../public")).filter(file => file.endsWith(".html"));
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
    assert.doesNotMatch(html, /class=["']bottom-nav["']/i, `${file} has no bottom navigation`);
  }
  const css = fs.readFileSync(path.join(__dirname, "../public/style.css"), "utf8");
  assert.doesNotMatch(css, /\.bottom-nav\b/);
  assert.doesNotMatch(css, /body\s*\{[^}]*padding-bottom:\s*70px/i);
});
test("checkout reuses its idempotency key after a failed request and clears it only on confirmed success", async () => {
  let postedKey;
  const failed = checkoutBrowser({ fetchImpl: async (_url, options) => {
    postedKey = options.headers["Idempotency-Key"];
    return { ok: false, json: async () => ({ error: "Temporary failure" }) };
  } });
  await failed.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(postedKey, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(failed.storage.has("cart"), true);
  assert.equal(failed.storage.get("artcorner.checkout.idempotencyKey"), postedKey);
  const succeeded = checkoutBrowser({ fetchImpl: async (_url, options) => {
    assert.equal(options.headers["Idempotency-Key"], postedKey);
    return { ok: true, json: async () => ({
      orderId: "ORD-123e4567-e89b-42d3-a456-426614174000", publicReference: "AC-7K2P9", confirmationToken: "signed-test-token"
    }) };
  } });
  succeeded.storage.set("artcorner.checkout.idempotencyKey", postedKey);
  await succeeded.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(succeeded.storage.has("cart"), false);
  assert.equal(succeeded.storage.has("artcorner.checkout.idempotencyKey"), false);
});
test("checkout rejects invalid customer details without sending or clearing the cart", async () => {
  let requests = 0;
  const browser = checkoutBrowser({ fetchImpl: async () => { requests++; throw new Error("should not submit"); } });
  browser.nodes.email.value = "invalid-address";
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(browser.storage.has("cart"), true);
  assert.match(browser.nodes.emailError.textContent, /valid email/i);
  assert.match(browser.nodes.checkoutFeedback.textContent, /highlighted details/i);

  const invalidPhone = checkoutBrowser({ fetchImpl: async () => { requests++; throw new Error("should not submit"); } });
  invalidPhone.nodes.phone.value = "1234567";
  await invalidPhone.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(invalidPhone.storage.has("cart"), true);
  assert.match(invalidPhone.nodes.phoneError.textContent, /Indian mobile number/i);
});
test("checkout summary renders attacker-controlled cart names as text", () => {
  const payload = '<svg onload="alert(1)">';
  const browser = checkoutBrowser({ cart: [{ _id: "p1", name: payload, price: 25, qty: 1 }] });
  const row = browser.nodes.checkoutSummaryItems.children[0];
  assert.equal(row.children[0].textContent, `${payload} · 1`);
  assert.equal(row.innerHTML, "");
  assert.equal(row.children.some(child => child.tagName === "svg"), false);
});
test("legacy confirmation URL is not accepted as proof and does not submit checkout", () => {
  const orderId = "ORD-123e4567-e89b-42d3-a456-426614174000";
  const browser = checkoutBrowser({ search: `?orderId=${orderId}`, cart: undefined, fetchImpl: async () => { throw new Error("unexpected request"); } });
  assert.equal(browser.nodes.legacyOrderNotice.hidden, false);
  assert.match(browser.nodes.legacyOrderNoticeText.textContent, new RegExp(orderId));
  assert.match(browser.nodes.legacyOrderNoticeText.textContent, /cannot be verified/i);
  assert.equal(browser.nodes.checkoutForm.hidden, true);
  assert.equal(browser.nodes.checkoutForm.onsubmit, null);
});

test("public order references are short and confirmation tokens expire safely", () => {
  const references = Array.from({ length: 100 }, generatePublicOrderReference);
  assert.ok(references.every(reference => /^AC-[A-HJ-NP-Z2-9]{5}$/.test(reference)));
  const token = createOrderConfirmationToken("AC-7K2P9", "unit-test-secret", 1000);
  assert.equal(verifyOrderConfirmationToken(token, "unit-test-secret", 1001), "AC-7K2P9");
  assert.equal(verifyOrderConfirmationToken(token, "wrong-secret", 1001), null);
  assert.equal(verifyOrderConfirmationToken(token, "unit-test-secret", 1000 + 7 * 24 * 60 * 60 * 1000), null);
});
test("order public references have a unique partial index and retry reference collisions", async () => {
  const referenceIndex = Order.schema.indexes().find(([keys]) => keys.publicReference === 1);
  assert.ok(referenceIndex);
  assert.equal(referenceIndex[1].unique, true);
  assert.deepEqual(referenceIndex[1].partialFilterExpression, { publicReference: { $type: "string" } });
  const originalSave = Order.prototype.save;
  const originalProductFind = Product.find;
  const originalOrderFindOne = Order.findOne;
  Product.find = () => productFindResult([{ _id: testProductId, name: "Sample", price: 10, inStock: true }]);
  Order.findOne = () => ({ select: async () => null });
  let attempts = 0;
  let firstReference;
  Order.prototype.save = async function () {
    attempts++;
    if (attempts === 1) {
      firstReference = this.publicReference;
      const error = new Error("duplicate public reference");
      error.code = 11000;
      error.keyPattern = { publicReference: 1 };
      throw error;
    }
    return this;
  };
  try {
    const response = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: validCheckoutBody([{ _id: testProductId, qty: 1 }]),
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(response.statusCode, 201);
    assert.equal(attempts, 2);
    assert.notEqual(response.body.publicReference, firstReference);
  } finally {
    Order.prototype.save = originalSave;
    Product.find = originalProductFind;
    Order.findOne = originalOrderFindOne;
  }
});

test("order confirmation API requires a valid token and returns only a safe order summary", async () => {
  const originalFindOne = Order.findOne;
  let filter;
  Order.findOne = value => {
    filter = value;
    return { select() { return { lean: async () => ({
      publicReference: "AC-7K2P9", status: "Placed", customer: { name: "Private customer" },
      items: [{ name: "Candle", qty: 2, price: 100 }]
    }) }; } };
  };
  try {
    const handler = routeStack("get", "/api/order-confirmation", authApp).at(-1);
    const invalid = await invoke(handler, { headers: { "x-order-confirmation": "bad" } });
    assert.equal(invalid.statusCode, 401);
    const token = createOrderConfirmationToken("AC-7K2P9", "test-only-session-secret-with-enough-length");
    const response = await invoke(handler, { headers: { "x-order-confirmation": token } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(filter, { publicReference: "AC-7K2P9" });
    assert.deepEqual(response.body, {
      publicReference: "AC-7K2P9", status: "Placed", items: [{ name: "Candle", qty: 2, price: 100 }],
      paymentStatus: null, paymentAmount: null, currency: null, upiPayment: null
    });
    assert.equal(JSON.stringify(response.body).includes("Private customer"), false);
    assert.equal(JSON.stringify(response.body).includes("orderId"), false);
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("customer order lookup requires both identifiers, normalizes phone formats and returns only safe fields", async () => {
  const originalFindOne = Order.findOne;
  const appForLookup = createApp({ storefrontOrigin: "http://localhost:3000", whatsappEnv: { WHATSAPP_BUSINESS_RECIPIENT: "919380125087" }, upiEnv: {} });
  const order = {
    _id: "mongodb-internal-id", orderId: "ORD-123e4567-e89b-42d3-a456-426614174000", publicReference: "AC-7K2P9",
    customer: { name: "Customer", phone: "+91 98765 43210", email: "private@example.com", address: "Private delivery address" },
    items: [{ productId: "64b64c0f1f1f1f1f1f1f1f1f", name: "Candle", qty: 2, price: 100, lineTotal: 200, image: "/uploads/candle.jpg" }],
    subtotal: 200, total: 200, paymentAmount: 200, currency: "INR", paymentStatus: "Pending", paymentMethod: "UPI",
    status: "Placed", createdAt: new Date("2026-10-01T10:00:00Z"), statusHistory: [{ status: "Placed", at: new Date("2026-10-01T10:00:00Z") }],
    customerWhatsAppOptIn: true, paymentVerifiedBy: "secret-admin", paymentReference: "private-utr",
    whatsappNotificationStatus: "sent", whatsappNotificationMessageId: "private-message", whatsappOutbox: [{ key: "private" }]
  };
  let capturedQuery;
  Order.findOne = query => { capturedQuery = query; return { select() { return this; }, lean: async () => order }; };
  try {
    const handler = routeStack("post", "/api/order-lookup", appForLookup).at(-1);
    const missing = await invoke(handler, { body: { orderReference: "AC-7K2P9" } });
    assert.equal(missing.statusCode, 400);
    const result = await invoke(handler, { body: { orderReference: "AC-7K2P9", phone: "(987) 654-3210", status: "Delivered", paymentStatus: "Paid" } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(capturedQuery, { publicReference: "AC-7K2P9" });
    assert.equal(result.body.publicReference, "AC-7K2P9");
    assert.equal(result.body.paymentStatus, "Pending");
    assert.equal(order.paymentStatus, "Pending", "public input cannot update payment or fulfilment state");
    assert.equal(result.body.status, "Placed");
    assert.equal(result.body.items[0].image, "/uploads/candle.jpg");
    assert.match(result.body.sharePaymentDetailsUrl, /^https:\/\/wa\.me\/919380125087/);
    assert.match(result.body.contactWhatsAppUrl, /^https:\/\/wa\.me\/919380125087/);
    const serialized = JSON.stringify(result.body);
    for (const privateValue of ["mongodb-internal-id", "ORD-123e4567-e89b-42d3-a456-426614174000", "private@example.com", "Private delivery address", "secret-admin", "private-utr", "private-message", "whatsappOutbox", "+91 98765"]) {
      assert.equal(serialized.includes(privateValue), false, `${privateValue} is not returned`);
    }
  } finally { Order.findOne = originalFindOne; }
});

test("customer order lookup uses one generic mismatch response and supports legacy timeline records", async () => {
  const originalFindOne = Order.findOne;
  const lookupApp = createApp({ storefrontOrigin: "http://localhost:3000", whatsappEnv: { WHATSAPP_BUSINESS_RECIPIENT: "919380125087" } });
  let savedOrder = null;
  Order.findOne = query => ({ select() { return this; }, lean: async () => query.publicReference
    ? (savedOrder?.publicReference === query.publicReference ? savedOrder : null)
    : (savedOrder?.orderId === query.orderId ? savedOrder : null) });
  try {
    const handler = routeStack("post", "/api/order-lookup", lookupApp).at(-1);
    const wrongReference = await invoke(handler, { body: { orderReference: "AC-XXXXX", phone: "9876543210" } });
    savedOrder = { orderId: "ORD-legacy", customer: { phone: "09876543210" }, items: [{ name: "Old order item", qty: 1, price: 75 }], status: "Delivered", createdAt: new Date("2025-01-01T10:00:00Z") };
    const wrongPhone = await invoke(handler, { body: { orderReference: "ORD-legacy", phone: "9888888888" } });
    const missingPayment = await invoke(handler, { body: { orderReference: "ORD-legacy", phone: "+91 98765 43210" } });
    assert.equal(wrongReference.statusCode, 404);
    assert.deepEqual(wrongReference.body, wrongPhone.body);
    assert.equal(missingPayment.statusCode, 200);
    assert.equal(missingPayment.body.publicReference, "ORD-legacy");
    assert.equal(missingPayment.body.paymentStatus, null);
    assert.equal(missingPayment.body.paymentAmount, null);
    assert.equal(missingPayment.body.timeline.some(event => event.status === "Delivered" && event.at === null), true);
    assert.equal(missingPayment.body.sharePaymentDetailsUrl, undefined, "payment-share link requires recorded opt-in");
    assert.match(missingPayment.body.contactWhatsAppUrl, /^https:\/\/wa\.me\/919380125087/);
    assert.equal(normalizeCustomerPhone("(987) 654-3210"), "919876543210");
    assert.equal(normalizeCustomerPhone("+91 98765 43210"), "919876543210");
    assert.equal(normalizeCustomerPhone("09876543210"), "919876543210");
    assert.equal(normalizeCustomerPhone("0091 09876543210"), "919876543210");
    assert.equal(normalizeCustomerPhone("123"), null);
  } finally { Order.findOne = originalFindOne; }
});

test("legacy order timeline uses only recorded dates and states", () => {
  const timeline = buildOrderTimeline({ status: "Shipped", createdAt: new Date("2025-01-01T00:00:00Z") });
  assert.deepEqual(timeline, [
    { type: "fulfilment", status: "Placed", at: "2025-01-01T00:00:00.000Z" },
    { type: "fulfilment", status: "Shipped", at: null }
  ]);
});
test("payment mismatch and cancellation timelines do not imply a completed delivery", () => {
  const mismatch = buildOrderTimeline({
    status: "Placed", paymentStatus: "Failed / Mismatch", createdAt: new Date("2025-01-01T00:00:00Z"),
    statusHistory: [{ status: "Placed", at: new Date("2025-01-01T00:00:00Z") }]
  });
  assert.deepEqual(mismatch.map(event => event.status), ["Placed", "Failed / Mismatch"]);
  assert.equal(mismatch.some(event => event.status === "Delivered"), false);
  const cancelled = buildOrderTimeline({
    status: "Cancelled", createdAt: new Date("2025-01-01T00:00:00Z"),
    statusHistory: [{ status: "Placed", at: new Date("2025-01-01T00:00:00Z") }, { status: "Cancelled", at: new Date("2025-01-02T00:00:00Z") }]
  });
  assert.deepEqual(cancelled.map(event => event.status), ["Placed", "Cancelled"]);
});

test("customer order lookup applies separate phone-based and IP-based rate limits", async () => {
  const originalFindOne = Order.findOne;
  Order.findOne = () => ({ select() { return this; }, lean: async () => null });
  try {
    await withHttpApp(async ({ request }) => {
      for (let i = 0; i < 5; i++) {
        const response = await request("/api/order-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderReference: "AC-7K2P9", phone: "9876543210" }) });
        assert.equal(response.response.status, 404);
      }
      const limited = await request("/api/order-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderReference: "AC-7K2P9", phone: "9876543210" }) });
      assert.equal(limited.response.status, 429, "sixth lookup for the same normalized phone is rate limited");
    });
    await withHttpApp(async ({ request }) => {
      for (let i = 0; i < 30; i++) {
        const phone = String(9876540000 + i);
        const response = await request("/api/order-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderReference: "AC-7K2P9", phone }) });
        assert.equal(response.response.status, 404);
      }
      const limited = await request("/api/order-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderReference: "AC-7K2P9", phone: "9876540030" }) });
      assert.equal(limited.response.status, 429, "31st request from one IP is rate limited despite distinct phone values");
    });
  } finally { Order.findOne = originalFindOne; }
});

test("UPI payment URI and QR use the trusted amount, encoded payee details, and public reference", async () => {
  const order = { _id: "internal-only", orderId: "ORD-internal", publicReference: "AC-7K2P9", paymentStatus: "Pending", paymentAmount: 251.25 };
  const urisSentToQr = [];
  const payment = await createUpiPaymentDetails(order, {
    env: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner & Crafts" },
    qrCode: { toDataURL: async (uri, options) => {
      urisSentToQr.push({ uri, options });
      return "data:image/png;base64,cXJjb2Rl";
    } }
  });
  const parsed = new URL(payment.uri);
  assert.equal(parsed.protocol, "upi:");
  assert.equal(parsed.hostname, "pay");
  assert.equal(parsed.searchParams.get("pa"), "art.corner@bank");
  assert.equal(parsed.searchParams.get("pn"), "Art Corner & Crafts");
  assert.equal(parsed.searchParams.get("am"), "251.25");
  assert.equal(parsed.searchParams.get("cu"), "INR");
  assert.equal(parsed.searchParams.get("tn"), "AC-7K2P9");
  assert.match(payment.uri, /pn=Art\+Corner\+%26\+Crafts/);
  assert.equal(urisSentToQr[0].uri, payment.uri);
  assert.equal(urisSentToQr[0].options.width, 280);
  assert.equal(payment.qrCodeDataUrl, "data:image/png;base64,cXJjb2Rl");
  assert.equal(JSON.stringify(payment).includes("internal-only"), false);
  const realQr = await createUpiPaymentDetails(order, { env: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner & Crafts" } });
  assert.match(realQr.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(await createUpiPaymentDetails(order, { env: {} }), null);
  assert.equal(await createUpiPaymentDetails({ ...order, paymentStatus: undefined }, { env: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner" } }), null);
  const qrFailure = await createUpiPaymentDetails(order, {
    env: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner" },
    qrCode: { toDataURL: async () => { throw new Error("private generator detail"); } }
  });
  assert.equal(qrFailure.uri, payment.uri.replace("Art+Corner+%26+Crafts", "Art+Corner"));
  assert.equal(qrFailure.qrCodeDataUrl, null);
});

test("order confirmation returns server payment details only with its signed token and leaves payment Pending", async () => {
  const originalFindOne = Order.findOne;
  const savedOrder = {
    _id: "private-db-id", orderId: "ORD-private", publicReference: "AC-7K2P9", status: "Placed",
    paymentStatus: "Pending", paymentAmount: 375, currency: "INR", items: [{ name: "Candle", qty: 1, price: 375 }]
  };
  let qrUri;
  let query;
  Order.findOne = value => {
    query = value;
    return { select: () => ({ lean: async () => savedOrder }) };
  };
  const paymentApp = createApp({
    sessionSecret: "signed-order-confirmation-test-secret",
    storefrontOrigin: "http://localhost:3000",
    upiEnv: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner Bengaluru" },
    qrCodeGenerator: { toDataURL: async uri => { qrUri = uri; return "data:image/png;base64,cXJjb2Rl"; } }
  });
  const handler = routeStack("get", "/api/order-confirmation", paymentApp).at(-1);
  try {
    const unauthorized = await invoke(handler, { headers: { "x-order-confirmation": "invalid" } });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.body.upiPayment, undefined);

    const token = createOrderConfirmationToken("AC-7K2P9", "signed-order-confirmation-test-secret");
    const confirmed = await invoke(handler, { headers: { "x-order-confirmation": token } });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(query.publicReference, "AC-7K2P9");
    assert.equal(confirmed.body.paymentStatus, "Pending");
    assert.equal(confirmed.body.paymentAmount, 375);
    assert.equal(confirmed.body.upiPayment.amount, 375);
    assert.equal(confirmed.body.upiPayment.reference, "AC-7K2P9");
    assert.equal(qrUri, confirmed.body.upiPayment.uri);
    assert.equal(JSON.stringify(confirmed.body).includes("ORD-private"), false);
    assert.equal(savedOrder.paymentStatus, "Pending", "reading payment instructions does not change payment status");
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("order success page shows UPI pending instructions, supports copying, and keeps a no-config fallback", async () => {
  const env = { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner Bengaluru" };
  const trusted = await createUpiPaymentDetails({ publicReference: "AC-7K2P9", paymentStatus: "Pending", paymentAmount: 290 }, {
    env, qrCode: { toDataURL: async () => "data:image/png;base64,cXJjb2Rl" }
  });
  let copied = "";
  const browser = await orderSuccessBrowser({
    responseBody: {
      publicReference: "AC-7K2P9", status: "Placed", items: [{ name: "Resin tray", qty: 1, price: 290 }],
      paymentStatus: "Pending", paymentAmount: 290, currency: "INR", upiPayment: trusted,
      sharePaymentDetailsUrl: "https://wa.me/919380125087?text=Order%20AC-7K2P9"
    },
    clipboard: async value => { copied = value; }
  });
  assert.equal(browser.nodes.orderSuccessHeading.textContent, "Order received — payment pending");
  assert.equal(browser.nodes.orderSuccessMark.textContent, "₹");
  assert.equal(browser.nodes.upiPaymentAmount.textContent, "Amount to pay: ₹290.00 INR");
  assert.equal(browser.nodes.upiPayButton.textContent, "Pay ₹290.00 using UPI");
  assert.equal(browser.nodes.upiPayButton.href, trusted.uri);
  assert.equal(browser.nodes.sharePaymentDetailsLink.href, "https://wa.me/919380125087?text=Order%20AC-7K2P9");
  assert.equal(browser.nodes.sharePaymentDetailsLink.hidden, false);
  assert.equal(browser.nodes.upiQrImage.src, trusted.qrCodeDataUrl);
  assert.equal(browser.nodes.upiQrImage.hidden, true, "image remains hidden until browser confirms it loaded");
  browser.nodes.upiQrImage.onload();
  assert.equal(browser.nodes.upiQrImage.hidden, false);
  await browser.nodes.copyUpiIdButton.handlers.click();
  assert.equal(copied, "art.corner@bank");
  assert.equal(browser.nodes.copyUpiIdButton.textContent, "UPI ID copied");
  assert.equal(browser.fetchCalls.length, 1, "opening payment instructions does not submit another order");
  assert.equal(browser.fetchCalls[0].url, "/api/order-confirmation");
  assert.equal(browser.fetchCalls[0].options.method, undefined);
  assert.equal(browser.nodes.orderSuccessCard.attributes["aria-busy"], "false");

  const noConfig = await orderSuccessBrowser({ responseBody: {
    publicReference: "AC-7K2P9", status: "Placed", items: [], paymentStatus: "Pending",
    paymentAmount: 290, currency: "INR", upiPayment: null
  } });
  assert.equal(noConfig.nodes.upiPaymentPanel.hidden, false);
  assert.equal(noConfig.nodes.upiPayButton.hidden, true);
  assert.match(noConfig.nodes.upiPaymentUnavailable.textContent, /contact the store/i);
  assert.equal(noConfig.nodes.orderSuccessHeading.textContent, "Order received — payment pending");

  const legacy = await orderSuccessBrowser({ responseBody: { publicReference: "AC-7K2P9", status: "Placed", items: [] } });
  assert.equal(legacy.nodes.upiPaymentPanel.hidden, true, "the payment panel remains hidden for legacy orders");
  assert.match(legacy.nodes.orderSuccessMessage.textContent, /payment details are unavailable/i);
});

test("order success page clearly separates verification, paid, mismatch and refunded states", async () => {
  const cases = [
    ["Verification Pending", "Payment submitted — verification pending", /do not pay again/i],
    ["Paid", "Payment verified — thank you!", /confirmed/i],
    ["Failed / Mismatch", "Payment needs review", /before making another payment/i],
    ["Refunded", "Payment refunded", /has been refunded/i]
  ];
  for (const [paymentStatus, heading, messagePattern] of cases) {
    const browser = await orderSuccessBrowser({ responseBody: {
      publicReference: "AC-7K2P9", status: "Placed", items: [], paymentStatus,
      paymentAmount: 100, currency: "INR", upiPayment: null
    } });
    assert.equal(browser.nodes.orderSuccessHeading.textContent, heading, paymentStatus);
    assert.match(browser.nodes.orderSuccessMessage.textContent, messagePattern, paymentStatus);
    assert.equal(browser.nodes.upiPaymentPanel.hidden, true, `${paymentStatus} must not expose another-payment instructions`);
    assert.equal(browser.nodes.upiPayButton.hidden, true, `${paymentStatus} must not offer a payment link`);
  }
});

test("production configuration requires explicit production mode and a valid storefront origin", () => {
  const valid = {
    NODE_ENV: "production", MONGO_URI: "mongodb://test.invalid/db", SESSION_SECRET: "x".repeat(40),
    ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD_HASH: testPasswordHash, STOREFRONT_ORIGIN: "https://storefront.example.test",
    CLOUDINARY_CLOUD_NAME: "test-cloud", CLOUDINARY_API_KEY: "test-key", CLOUDINARY_API_SECRET: "test-secret"
  };
  assert.doesNotThrow(() => validateProductionConfig(valid));
  assert.throws(() => validateProductionConfig({ ...valid, NODE_ENV: undefined }), /NODE_ENV must be explicitly/);
  assert.throws(() => validateProductionConfig({ ...valid, STOREFRONT_ORIGIN: undefined }), /STOREFRONT_ORIGIN/);
  assert.throws(() => validateProductionConfig({ ...valid, STOREFRONT_ORIGIN: "http://storefront.example.test" }), /HTTPS origin/);
  assert.throws(() => validateProductionConfig({ ...valid, CLOUDINARY_API_SECRET: undefined }), /CLOUDINARY_API_SECRET/);
});
test("production createApp requires an explicitly configured persistent session store", () => {
  assert.throws(() => createApp({ production: true }), /persistent session store is required in production/i);
  assert.throws(() => createApp({ production: true, sessionStore: new session.MemoryStore() }), /persistent session store is required in production/i);
});
test("production module import does not construct an unused MemoryStore application", () => {
  const child = spawnSync(process.execPath, ["-e", 'const { app } = require("./server"); if (app !== null) process.exitCode = 2;'], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /MemoryStore is not designed for a production environment/i);
});
test("session store readiness check blocks startup on initialization errors", async () => {
  let probedId;
  await verifySessionStoreReady({ get(id, callback) { probedId = id; callback(null, null); } });
  assert.equal(probedId, "__startup_readiness_check__");
  await assert.rejects(verifySessionStoreReady({ get(_id, callback) { callback(new Error("store initialization failed")); } }), /store initialization failed/);
  await assert.rejects(verifySessionStoreReady(null), /valid session store/);
});
test("session store readiness check fails promptly if the store never calls back", async () => {
  let lateCallback;
  await assert.rejects(
    verifySessionStoreReady({ get(_id, callback) { lateCallback = callback; } }, 10),
    /Session store readiness check timed out after 10 ms/
  );
  assert.equal(typeof lateCallback, "function");
  assert.doesNotThrow(() => lateCallback(null, null));
});
test("startup stage diagnostics log timing and rethrow failures", async () => {
  const logs = [];
  const logger = {
    log(message) { logs.push(message); },
    error(message) { logs.push(message); }
  };
  const result = await runStartupStage("test stage", async () => "ready", logger);
  assert.equal(result, "ready");
  assert.match(logs[0], /Startup stage "test stage" started/);
  assert.match(logs[1], /Startup stage "test stage" completed in \d+ ms/);

  const failure = new Error("private details should not be logged");
  logs.length = 0;
  await assert.rejects(runStartupStage("failing stage", async () => { throw failure; }, logger), error => error === failure);
  assert.match(logs[0], /Startup stage "failing stage" started/);
  assert.match(logs[1], /Startup stage "failing stage" failed after \d+ ms \(Error\)/);
  assert.doesNotMatch(logs.join(" "), /private details/);
});
test("HTTP login rotates an existing session ID and sets production cookie flags", async () => {
  await withHttpApp(async ({ store, request }) => {
    const oldSid = "pre-login-session-id";
    await seedSession(store, oldSid);
    const result = await request("/api/admin/login", {
      method: "POST", cookie: signedSessionCookie(oldSid),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(result.text), { authenticated: true });
    const cookie = sessionCookie(result.setCookies);
    assert.notEqual(sessionIdFromCookie(cookie), oldSid, "login must rotate the session ID");
    const header = result.setCookies.find(value => value.startsWith(`${sessionCookieName}=`));
    assert.match(header, /; Path=\//i);
    assert.match(header, /; HttpOnly/i);
    assert.match(header, /; Secure/i);
    assert.match(header, /; SameSite=Lax/i);
  });
});
test("HTTP login rejects incorrect credentials and oversized passwords", async () => {
  await withHttpApp(async ({ request }) => {
    const failed = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "wrong-password" })
    });
    assert.equal(failed.response.status, 401);
    const tooLong = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "x".repeat(257) })
    });
    assert.equal(tooLong.response.status, 400);
    assert.match(tooLong.text, /256 characters/);
  });
});
test("HTTP admin APIs reject requests without an authenticated session", async () => {
  await withHttpApp(async ({ request }) => {
    for (const [method, routePath] of [["POST", "/api/products"], ["DELETE", "/api/products/not-an-id"], ["PUT", "/api/products/not-an-id"], ["GET", "/api/orders"], ["PUT", "/api/orders/ORD-test"], ["PUT", "/api/admin/orders/ORD-test/payment-verification"], ["POST", "/api/admin/orders/ORD-test/notifications/key/retry"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/retry"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/confirm-sent"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/confirm-not-sent-retry"]]) {
      const result = await request(routePath, { method });
      assert.equal(result.response.status, 401, `${method} ${routePath}`);
      assert.match(result.text, /Authentication required/);
    }
  });
});
test("HTTP admin payment verification accepts a trusted authenticated session and updates once", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalExists = Order.exists;
  let updateCalls = 0;
  let capturedUpdate;
  Order.findOne = () => ({ select: async () => ({ customerWhatsAppOptIn: false, paymentStatus: "Pending" }) });
  Order.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    updateCalls++;
    return updateCalls === 1 ? { orderId: "ORD-http-test", paymentStatus: "Paid", status: "Preparing", paymentVerifiedAt: new Date(), paymentVerifiedBy: "test-admin" } : null;
  };
  Order.exists = async () => true;
  try {
    await withHttpApp(async ({ request }) => {
      const login = await request("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test-admin", password: "test-only-password" }) });
      const cookie = sessionCookie(login.setCookies);
      const verify = () => request("/api/admin/orders/ORD-http-test/payment-verification", { method: "PUT", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", paymentReference: "UTR-HTTP" }) });
      const first = await verify();
      assert.equal(first.response.status, 200);
      assert.equal(JSON.parse(first.text).paymentStatus, "Paid");
      assert.equal(capturedUpdate.$set.status, "Preparing");
      const duplicate = await verify();
      assert.equal(duplicate.response.status, 409);
    });
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.exists = originalExists;
  }
});
test("unauthenticated multipart product upload is rejected before image processing", async () => {
  await withHttpApp(async ({ request }) => {
    const form = new FormData();
    form.append("image", new Blob([validPngFile().buffer], { type: "image/png" }), "product.png");
    const result = await request("/api/products", { method: "POST", body: form });
    assert.equal(result.response.status, 401);
  });
});
test("HTTP product upload rejects unsupported file types and files over 5 MB", async () => {
  await withHttpApp(async ({ request }) => {
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    const unsupported = new FormData();
    unsupported.append("image", new Blob(["not an image"], { type: "application/pdf" }), "document.pdf");
    const invalid = await request("/api/products", { method: "POST", cookie, body: unsupported });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.text, /JPEG, PNG, WebP, or GIF/);

    const oversized = new FormData();
    oversized.append("image", new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
    const tooLarge = await request("/api/products", { method: "POST", cookie, body: oversized });
    assert.equal(tooLarge.response.status, 413);
    assert.match(tooLarge.text, /5 MB or smaller/);
  });
});
test("HTTP product upload stores the Cloudinary URL and public ID after upload succeeds", async () => {
  await withCategoryMocks(async () => {
    const cloudinaryClient = makeCloudinaryMock();
    let savedProduct;
    stub(Product.prototype, "save", async function () { savedProduct = this; return this; });
    await withHttpApp(async ({ request }) => {
      const login = await request("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
      });
      const form = new FormData();
      form.append("name", "Test candle");
      form.append("price", "250");
      form.append("categoryId", "1");
      form.append("image", new Blob([validPngFile().buffer], { type: "image/png" }), "product.png");
      const result = await request("/api/products", { method: "POST", cookie: sessionCookie(login.setCookies), body: form });
      assert.equal(result.response.status, 201);
      const body = JSON.parse(result.text);
      assert.equal(body.product.image, "https://images.example.test/art-corner/item.png");
      assert.equal(savedProduct.imagePublicId, "art-corner/products/item");
      assert.equal(cloudinaryClient.uploaded.length, 1);
      assert.equal(cloudinaryClient.uploaded[0].options.folder, "art-corner/products");
    }, { cloudinaryClient, cloudinaryConfigured: true });
  });
  restore();
});
test("HTTP Cloudinary failure returns a safe error and does not save a product", async () => {
  await withCategoryMocks(async () => {
    const cloudinaryClient = makeCloudinaryMock({ fail: true });
    let saved = false;
    stub(Product.prototype, "save", async function () { saved = true; return this; });
    await withHttpApp(async ({ request }) => {
      const login = await request("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
      });
      const form = new FormData();
      form.append("name", "Test candle");
      form.append("price", "250");
      form.append("categoryId", "1");
      form.append("image", new Blob([validPngFile().buffer], { type: "image/png" }), "product.png");
      const result = await request("/api/products", { method: "POST", cookie: sessionCookie(login.setCookies), body: form });
      assert.equal(result.response.status, 502);
      assert.match(result.text, /Image upload failed/);
      assert.doesNotMatch(result.text, /provider details/);
      assert.equal(saved, false);
    }, { cloudinaryClient, cloudinaryConfigured: true });
  });
  restore();
});
test("HTTP cookie authorizes protected API and logout invalidates it", async () => {
  await withHttpApp(async ({ request }) => {
    const originalFind = Order.find;
    Order.find = () => ({ sort: async () => [{ orderId: "ORD-test", status: "Placed" }] });
    try {
      const login = await request("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
      });
      const cookie = sessionCookie(login.setCookies);
      const authorized = await request("/api/orders", { cookie });
      assert.equal(authorized.response.status, 200);
      assert.equal(JSON.parse(authorized.text)[0].orderId, "ORD-test");
      const retryWhenUnconfigured = await request("/api/admin/orders/ORD-test/whatsapp-notification/retry", { method: "POST", cookie, origin: testOrigin });
      assert.equal(retryWhenUnconfigured.response.status, 503, "authenticated request reaches retry handling but sends nothing without config");
      const logout = await request("/api/admin/logout", { method: "POST", cookie });
      assert.equal(logout.response.status, 204);
      assert.match(logout.setCookies.join(";"), /artcorner\.sid=;/);
      const afterLogout = await request("/api/orders", { cookie });
      assert.equal(afterLogout.response.status, 401);
    } finally {
      Order.find = originalFind;
    }
  }, { whatsappEnv: {} });
});
test("HTTP admin state changes reject untrusted and missing origins", async () => {
  await withHttpApp(async ({ request }) => {
    const blockedLogin = await request("/api/admin/login", {
      method: "POST", origin: "https://evil.storefront.example.test",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    assert.equal(blockedLogin.response.status, 403);
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    for (const [method, routePath] of [["POST", "/api/products"], ["DELETE", "/api/products/invalid"], ["PUT", "/api/products/invalid"], ["PUT", "/api/orders/ORD-test"], ["PUT", "/api/admin/orders/ORD-test/payment-verification"], ["POST", "/api/admin/orders/ORD-test/notifications/key/retry"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/retry"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/confirm-sent"], ["POST", "/api/admin/orders/ORD-test/whatsapp-notification/confirm-not-sent-retry"], ["POST", "/api/admin/logout"]]) {
      const result = await request(routePath, { method, cookie, origin: "https://evil.storefront.example.test" });
      assert.equal(result.response.status, 403, `${method} ${routePath}`);
    }
    const missing = await request("/api/admin/logout", { method: "POST", cookie, origin: null });
    assert.equal(missing.response.status, 403);
    const stillAuthorized = await request("/api/admin/session", { cookie });
    assert.equal(stillAuthorized.response.status, 200);
    assert.deepEqual(JSON.parse(stillAuthorized.text), { authenticated: true });
  });
});
test("legacy categories seed idempotently without changing their numeric IDs or names", async () => {
  await withCategoryMocks(async records => {
    await seedLegacyCategories();
    await seedLegacyCategories();
    assert.deepEqual(records.map(({ id, name }) => ({ id, name })), [
      { id: 1, name: "Candles" }, { id: 2, name: "Resin Art" }, { id: 3, name: "Bracelets" }
    ]);
  });
});
test("legacy category seed reports an ID conflict before writing categories", async () => {
  await withCategoryMocks(async records => {
    await assert.rejects(seedLegacyCategories(), /Category ID 1 is already assigned/);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "Resin Art");
  }, [{ id: 1, name: "Resin Art", normalizedName: "resin art", image: null }]);
});
test("legacy category seed stops before writes when a product uses an unmapped numeric ID", async () => {
  await withCategoryMocks(async records => {
    await assert.rejects(seedLegacyCategories(), /products use categoryId 4, but no category name is defined/);
    assert.equal(records.length, 0);
  }, [], [1, 2, 3, 4]);
});
test("GET /api/categories returns the legacy numeric IDs and compatible public fields", async () => {
  await withCategoryMocks(async () => withHttpApp(async ({ request }) => {
    const result = await request("/api/categories");
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(result.text), [
      { id: 1, name: "Candles", image: "/uploads/candle.jpg" },
      { id: 2, name: "Resin Art", image: "/uploads/resin.jpg" },
      { id: 3, name: "Bracelets", image: "/uploads/bracelet.jpg" }
    ]);
  }));
});
test("POST /api/categories requires admin session and trusted origin", async () => {
  await withCategoryMocks(async () => withHttpApp(async ({ request }) => {
    const body = JSON.stringify({ name: "Pottery" });
    const unauthorized = await request("/api/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(unauthorized.response.status, 401);
    const untrusted = await request("/api/categories", {
      method: "POST", origin: "https://sibling.storefront.example.test",
      headers: { "Content-Type": "application/json" }, body
    });
    assert.equal(untrusted.response.status, 403);
  }));
});
test("POST /api/categories allocates distinct numeric IDs concurrently", async () => {
  await withCategoryMocks(async records => withHttpApp(async ({ request }) => {
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    const add = name => request("/api/categories", {
      method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
    });
    const results = await Promise.all([add("Pottery"), add("Macrame")]);
    assert.deepEqual(results.map(result => result.response.status), [201, 201]);
    const categories = results.map(result => JSON.parse(result.text).category).sort((a, b) => a.id - b.id);
    assert.deepEqual(categories.map(category => category.id), [4, 5]);
    assert.deepEqual(categories.map(category => category.name), ["Pottery", "Macrame"]);
    assert.equal(records.length, 5);
  }));
});
test("POST /api/categories rejects invalid and duplicate names", async () => {
  await withCategoryMocks(async () => withHttpApp(async ({ request }) => {
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    const add = name => request("/api/categories", {
      method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
    });
    const blank = await add("   ");
    assert.equal(blank.response.status, 400);
    const duplicate = await add("candles");
    assert.equal(duplicate.response.status, 409);
    const tooLong = await add("x".repeat(81));
    assert.equal(tooLong.response.status, 400);
  }));
});
test("concurrent creation of the same normalized category name yields one category", async () => {
  await withCategoryMocks(async records => withHttpApp(async ({ request }) => {
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    const add = name => request("/api/categories", {
      method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
    });
    const results = await Promise.all([add("Pottery"), add(" pottery ")]);
    assert.deepEqual(results.map(result => result.response.status).sort(), [201, 409]);
    assert.equal(records.filter(category => category.normalizedName === "pottery").length, 1);
  }));
});
test("product creation rejects a category ID that is not present", async () => {
  stub(Category, "findOneAndUpdate", async filter => {
    assert.deepEqual(filter, { id: 99, deleting: { $ne: true } });
    return null;
  });
  try {
    const uploadApp = createApp({ cloudinaryConfigured: true, cloudinaryClient: makeCloudinaryMock() });
    const result = await invoke(routeStack("post", "/api/products", uploadApp).at(-1), {
      body: { name: "Sample", price: "10", categoryId: "99" }, file: validPngFile()
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error, "Selected category does not exist or is being deleted");
  } finally {
    restore();
  }
});
test("product creation reserves and releases a category assignment atomically", async () => {
  let released = false;
  stub(Category, "findOneAndUpdate", async filter => {
    assert.deepEqual(filter, { id: 1, deleting: { $ne: true } });
    return { id: 1 };
  });
  stub(Category, "updateOne", async (filter, update) => {
    assert.deepEqual(filter, { id: 1, pendingProductAssignments: { $gt: 0 } });
    assert.deepEqual(update, { $inc: { pendingProductAssignments: -1 } });
    released = true;
    return { matchedCount: 1 };
  });
  stub(Product.prototype, "save", async function () { return this; });
  const cloudinaryClient = makeCloudinaryMock();
  try {
    const uploadApp = createApp({ cloudinaryConfigured: true, cloudinaryClient });
    const result = await invoke(routeStack("post", "/api/products", uploadApp).at(-1), {
      body: { name: "Sample", price: "10", categoryId: "1" }, file: validPngFile()
    });
    assert.equal(result.statusCode, 201);
    assert.equal(released, true);
    assert.equal(result.body.product.image, "https://images.example.test/art-corner/item.png");
    assert.equal(result.body.product.imagePublicId, "art-corner/products/item");
    assert.equal(cloudinaryClient.uploaded.length, 1);
  } finally {
    restore();
  }
});
test("product upload rejects files without a supported matching image signature", async () => {
  const invalid = { ...validPngFile(), buffer: Buffer.from("not an image") };
  assert.equal(hasSupportedImageSignature(invalid), false);
  assert.equal(hasSupportedImageSignature({ ...validPngFile(), originalname: "file.exe" }), false);
});
test("legacy local product image paths remain served during the Cloudinary transition", async () => {
  await withHttpApp(async ({ request }) => {
    const result = await request("/uploads/candle.jpg");
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get("content-type"), /image\/jpeg/);
  });
});
test("Cloudinary upload failure preserves category reservation cleanup and creates no product", async () => {
  let released = false;
  let saved = false;
  stub(Category, "findOneAndUpdate", async () => ({ id: 1 }));
  stub(Category, "updateOne", async () => { released = true; return { matchedCount: 1 }; });
  stub(Product.prototype, "save", async function () { saved = true; return this; });
  try {
    const cloudinaryClient = makeCloudinaryMock({ fail: true });
    const uploadApp = createApp({ cloudinaryConfigured: true, cloudinaryClient });
    const result = await invoke(routeStack("post", "/api/products", uploadApp).at(-1), {
      body: { name: "Sample", price: "10", categoryId: "1" }, file: validPngFile()
    });
    assert.equal(result.statusCode, 502);
    assert.match(result.body.error, /Image upload failed/);
    assert.equal(saved, false);
    assert.equal(released, true);
  } finally {
    restore();
  }
});
test("product save failure retains the newly uploaded image when database outcome is uncertain", async () => {
  let released = false;
  stub(Category, "findOneAndUpdate", async () => ({ id: 1 }));
  stub(Category, "updateOne", async () => { released = true; return { matchedCount: 1 }; });
  stub(Product.prototype, "save", async function () { throw new Error("simulated database write failure"); });
  const cloudinaryClient = makeCloudinaryMock();
  try {
    const uploadApp = createApp({ cloudinaryConfigured: true, cloudinaryClient });
    await assert.rejects(invoke(routeStack("post", "/api/products", uploadApp).at(-1), {
      body: { name: "Sample", price: "10", categoryId: "1" }, file: validPngFile()
    }), /simulated database write failure/);
    assert.equal(released, true);
    assert.equal(cloudinaryClient.uploaded.length, 1);
    assert.deepEqual(cloudinaryClient.deleted, []);
  } finally {
    restore();
  }
});
test("admin product listing requires session and trusted origin, then includes out-of-stock products", async () => {
  await withHttpApp(async ({ request }) => {
    const unauthorized = await request("/api/admin/products");
    assert.equal(unauthorized.response.status, 401);
    const originalFind = Product.find;
    Product.find = async filter => {
      assert.deepEqual(filter, {});
      return [{ _id: "p1", inStock: true }, { _id: "p2", inStock: false }];
    };
    try {
      const login = await request("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
      });
      const cookie = sessionCookie(login.setCookies);
      const untrusted = await request("/api/admin/products", { cookie, origin: "https://evil.example.test" });
      assert.equal(untrusted.response.status, 403);
      const authorized = await request("/api/admin/products", { cookie, origin: testOrigin });
      assert.equal(authorized.response.status, 200);
      assert.deepEqual(JSON.parse(authorized.text).map(product => product.inStock), [true, false]);
      const sameOriginBrowserGet = await request("/api/admin/products", {
        cookie, origin: null,
        headers: { "Sec-Fetch-Site": "same-origin", Host: new URL(testOrigin).host }
      });
      assert.equal(sameOriginBrowserGet.response.status, 200, "same-origin browser GET may omit Origin");
      const missingOriginWithoutFetchMetadata = await request("/api/admin/products", { cookie, origin: null });
      assert.equal(missingOriginWithoutFetchMetadata.response.status, 403);
    } finally {
      Product.find = originalFind;
    }
  });
});
test("homepage renders API-driven collection cards and real in-stock featured products", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.match(html, /class="home-hero"/);
  assert.match(html, /Shop All Products/);
  assert.match(html, /id="featured-products"/);

  const categories = [{ id: 1, name: "Candles" }, { id: 4, name: "Pottery" }];
  const products = [
    { _id: "p1", name: "Tree Candle", categoryId: 1, price: 600, image: "/uploads/candle.jpg", inStock: true },
    { _id: "p2", name: "Out of stock", categoryId: 4, price: 1, image: "/uploads/out.jpg", inStock: false }
  ];
  const nodes = {
    categories: uiElement("div"),
    "home-category-status": uiElement("p"),
    "featured-products": uiElement("div"),
    "home-products-status": uiElement("p"),
    "hero-product-collage": uiElement("div"),
    "hero-collage-status": uiElement("p")
  };
  const success = await runBrowserScript("public/script.js", {
    nodes,
    fetchImpl: async url => ({
      ok: true,
      json: async () => url === "/api/categories" ? categories : products
    })
  });
  assert.equal(success.nodes.categories.children.length, 3, "All Products plus API categories render");
  assert.deepEqual(success.nodes.categories.children.map(card => card.children[1].children[0].textContent), ["All Products", "Candles", "Pottery"]);
  assert.equal(success.nodes.categories.children[1].href, "products.html?category=1");
  assert.equal(success.nodes.categories.children[1].children[0].children[1].src, "/uploads/candle.jpg");
  assert.equal(success.nodes["featured-products"].children.length, 1, "out-of-stock products stay hidden");
  assert.equal(success.nodes["featured-products"].children[0].children[1].children[0].textContent, "Tree Candle");
  assert.equal(success.nodes["hero-product-collage"].children[1].children[0].src, "/uploads/candle.jpg");
});
test("homepage uses saved HTTPS product images and neutral placeholders for ordinary products", async () => {
  const nodes = {
    categories: uiElement("div"),
    "home-category-status": uiElement("p"),
    "featured-products": uiElement("div"),
    "home-products-status": uiElement("p"),
    "hero-product-collage": uiElement("div"),
    "hero-collage-status": uiElement("p")
  };
  const products = [
    { _id: "cloud", name: "Cloudinary item", categoryId: 4, price: 10, image: "https://res.cloudinary.com/example/image/upload/item.jpg", inStock: true },
    { _id: "invalid", name: "Invalid image item", categoryId: 4, price: 10, image: "javascript:alert(1)", inStock: true },
    { _id: "empty", name: "No image item", categoryId: 4, price: 10, image: "", inStock: true }
  ];
  const result = await runBrowserScript("public/script.js", {
    nodes,
    fetchImpl: async url => ({ ok: true, json: async () => url === "/api/products" ? products : [] })
  });
  const cards = result.nodes["featured-products"].children;
  assert.equal(cards[0].children[0].children[0].src, products[0].image);
  assert.equal(result.nodes["hero-product-collage"].children[1].children[0].src, products[0].image, "hero collage uses the saved Cloudinary HTTPS URL");
  assert.equal(cards[0].children[0].children[1].hidden, false);
  cards[0].children[0].children[0].handlers.error();
  assert.equal(cards[0].children[0].children[0].removed, true);
  assert.equal(cards[0].children[0].children[1].hidden, false, "failed image requests retain the neutral fallback");
  assert.equal(cards[1].children[0].children.length, 1);
  assert.equal(cards[1].children[0].children[0].textContent, "Image unavailable");
  assert.equal(cards[2].children[0].children[0].textContent, "Image coming soon");
  assert.ok(cards.every(card => !card.children[0].children[0].className.includes("product-artwork")));
});
test("category-specific preview illustrations are limited to labeled local sample products", async () => {
  const nodes = {
    categories: uiElement("div"),
    "home-category-status": uiElement("p"),
    "featured-products": uiElement("div"),
    "home-products-status": uiElement("p"),
    "hero-product-collage": uiElement("div"),
    "hero-collage-status": uiElement("p")
  };
  const products = [
    { _id: "candle", name: "[LOCAL PREVIEW] Sample Candle", categoryId: 1, price: 10, image: "", inStock: true },
    { _id: "resin", name: "[LOCAL PREVIEW] Sample Resin", categoryId: 2, price: 10, image: "", inStock: true },
    { _id: "bracelet", name: "[LOCAL PREVIEW] Sample Bracelet", categoryId: 3, price: 10, image: "", inStock: true },
    { _id: "ordinary", name: "Ordinary Candle", categoryId: 1, price: 10, image: "", inStock: true }
  ];
  const result = await runBrowserScript("public/script.js", {
    nodes,
    fetchImpl: async url => ({ ok: true, json: async () => url === "/api/products" ? products : [] })
  });
  const cards = result.nodes["featured-products"].children;
  assert.equal(cards[0].children[0].children[0].src, "/uploads/candle.jpg");
  assert.match(cards[0].children[0].children[1].className, /product-artwork-candle/);
  assert.match(cards[1].children[0].children[0].className, /product-artwork-resin/);
  assert.match(cards[2].children[0].children[0].className, /product-artwork-bracelet/);
  assert.equal(cards[3].children[0].children[0].textContent, "Image coming soon");
  assert.doesNotMatch(cards[3].children[0].children[0].className, /product-artwork/);
});
test("homepage keeps useful API failure and empty states without inventing products", async () => {
  const nodes = {
    categories: uiElement("div"),
    "home-category-status": uiElement("p"),
    "featured-products": uiElement("div"),
    "home-products-status": uiElement("p"),
    "hero-product-collage": uiElement("div"),
    "hero-collage-status": uiElement("p")
  };
  const failed = await runBrowserScript("public/script.js", {
    nodes,
    fetchImpl: async () => ({ ok: false })
  });
  assert.equal(failed.nodes.categories.children.length, 1, "All Products remains available on category API failure");
  assert.match(failed.nodes["home-category-status"].textContent, /temporarily unavailable/i);
  assert.equal(failed.nodes["featured-products"].children.length, 0);
  assert.match(failed.nodes["home-products-status"].textContent, /temporarily unavailable/i);

  const emptyNodes = {
    categories: uiElement("div"),
    "home-category-status": uiElement("p"),
    "featured-products": uiElement("div"),
    "home-products-status": uiElement("p"),
    "hero-product-collage": uiElement("div"),
    "hero-collage-status": uiElement("p")
  };
  const empty = await runBrowserScript("public/script.js", {
    nodes: emptyNodes,
    fetchImpl: async () => ({ ok: true, json: async () => [] })
  });
  assert.equal(empty.nodes.categories.children.length, 1);
  assert.match(empty.nodes["home-category-status"].textContent, /No collections/i);
  assert.match(empty.nodes["home-products-status"].textContent, /no in-stock products/i);
});
test("product page uses fetched category names and still renders products if category loading fails", async () => {
  const categoryFilter = uiElement("select");
  const pageTitle = uiElement("h1");
  const productContainer = uiElement("div");
  const nodes = { categoryFilter, pageTitle, products: productContainer, search: uiElement("input") };
  await runBrowserScript("public/products.js", {
    nodes,
    search: "?category=4",
    fetchImpl: async url => url === "/api/categories"
      ? { ok: true, json: async () => [{ id: 4, name: "Pottery" }] }
      : { ok: true, json: async () => [{ _id: "p4", name: "Clay Bowl", categoryId: 4, inStock: true }] }
  });
  assert.equal(pageTitle.textContent, "Pottery");
  assert.deepEqual(categoryFilter.children.map(option => option.value), ["4"]);
  assert.equal(productContainer.children.length, 1);

  const failedNodes = { categoryFilter: uiElement("select"), pageTitle: uiElement("h1"), products: uiElement("div"), search: uiElement("input"), categoryFeedback: uiElement("p") };
  const failedBrowser = await runBrowserScript("public/products.js", {
    nodes: failedNodes,
    search: "?category=1",
    fetchImpl: async url => url === "/api/categories"
      ? { ok: false }
      : { ok: true, json: async () => [
        { _id: "p1", name: "Candle", categoryId: 1, inStock: true },
        { _id: "p2", name: "Resin piece", categoryId: 2, inStock: true }
      ] }
  });
  assert.equal(failedNodes.products.children.length, 2, "failed category lookup falls back to all in-stock products");
  assert.match(failedNodes.categoryFeedback.textContent, /all products are still shown/i);
  assert.equal(failedNodes.pageTitle.textContent, "✨ All Products");
  assert.equal(failedNodes.categoryFilter.value, "");
  assert.equal(failedBrowser.window.history.replacedUrl, "products.html");
});
test("public product listing renders hostile names as text and rejects unsafe image URLs", async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const nodes = { categoryFilter: uiElement("select"), pageTitle: uiElement("h1"), products: uiElement(), search: uiElement("input"), categoryFeedback: uiElement("p") };
  await runBrowserScript("public/products.js", {
    nodes,
    fetchImpl: async url => url === "/api/categories"
      ? { ok: true, json: async () => [] }
      : { ok: true, json: async () => [
        { _id: "p1", name: payload, image: 'https://res.cloudinary.com/demo/image/upload/a.jpg" onerror="alert(1)', price: 100, inStock: true },
        { _id: "p2", name: "Safe Cloudinary image", image: "https://res.cloudinary.com/demo/image/upload/b.jpg", price: 200, inStock: true },
        { _id: "p3", name: "Unsafe scheme", image: "javascript:alert(1)", price: 300, inStock: true },
        { _id: "p4", name: "Protocol relative", image: "//evil.example/image.jpg", price: 400, inStock: true },
        { _id: "p5", name: "Malformed URL", image: "https://[", price: 500, inStock: true }
      ] }
  });
  assert.equal(nodes.products.children.length, 5);
  assert.equal(nodes.products.children[0].children[0].textContent, payload);
  assert.equal(nodes.products.children[0].children.some(child => child.tagName === "img"), false);
  assert.equal(nodes.products.children[1].children[0].src, "https://res.cloudinary.com/demo/image/upload/b.jpg");
  assert.equal(nodes.products.children.slice(2).every(card => !card.children.some(child => child.tagName === "img")), true);
  assert.equal(nodes.products.children.every(card => card.innerHTML === ""), true);
});
test("product details safely render database fields and reject unsafe image URLs", async () => {
  const payload = '<svg onload="alert(1)">product</svg>';
  const nodes = { product: uiElement(), addToCart: uiElement("button") };
  await runBrowserScript("public/product.js", {
    nodes, search: "?id=p1",
    fetchImpl: async () => ({ ok: true, json: async () => ({ _id: "p1", name: payload, image: "data:text/html,<script>alert(1)</script>", price: 50, inStock: true }) })
  });
  assert.equal(nodes.product.children.find(child => child.tagName === "h2").textContent, payload);
  assert.equal(nodes.product.children.some(child => child.tagName === "img"), false);
  assert.equal(nodes.product.innerHTML, "");

  const safeNodes = { product: uiElement(), addToCart: uiElement("button") };
  await runBrowserScript("public/product.js", {
    nodes: safeNodes, search: "?id=p2",
    fetchImpl: async () => ({ ok: true, json: async () => ({ _id: "p2", name: "Legacy", image: "/uploads/candle.jpg", price: 50, inStock: true }) })
  });
  assert.equal(safeNodes.product.children[0].src, "/uploads/candle.jpg");
});
test("admin product list renders hostile product data safely and uses event listeners", async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const nodes = { products: uiElement(), category: uiElement("select"), categoryFeedback: uiElement("p") };
  const requests = [];
  await runBrowserScript("public/admin.js", {
    nodes, requireAdminPage: async () => true,
    fetchImpl: async url => {
      requests.push(url);
      if (url === "/api/categories") return { ok: true, json: async () => [] };
      if (url === "/api/admin/products") return { ok: true, json: async () => [{
        _id: "bad-id';alert(1);//", name: payload, image: "javascript:alert(1)", price: 12, inStock: true
      }] };
      return { ok: true, json: async () => ({}) };
    }
  });
  const card = nodes.products.children[0];
  assert.equal(card.children.find(child => child.tagName === "h3").textContent, payload);
  assert.equal(card.children.some(child => child.tagName === "img"), false);
  assert.equal(card.innerHTML, "");
  const actionButtons = card.children.filter(child => child.tagName === "button");
  assert.deepEqual(actionButtons.map(button => button.textContent), ["Delete", "Toggle Stock"]);
  assert.ok(actionButtons.every(button => typeof button.handlers.click === "function" && !button.attributes.onclick));
});
function makeOrdersPageNodes() {
  const nodes = Object.fromEntries([
    "ordersCards", "search", "filter", "dateFilter", "ordersCount", "notificationFeedback", "detailFeedback",
    "orderDetailsView", "orderDetailsContent", "orderDetailsTitle", "closeOrderDetails"
  ].map(id => [id, uiElement(id === "search" ? "input" : id.includes("Filter") || id === "filter" ? "select" : "div")]));
  nodes.orderDetailsView.hidden = true;
  return nodes;
}
function flattenUi(root) {
  return [root, ...(root.children || []).flatMap(flattenUi)];
}

test("admin order list and details safely render order data and reject unsafe product image URLs", async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const tbody = uiElement("tbody");
  const nodes = makeOrdersPageNodes();
  const order = {
    orderId: "ORD-safe-123", publicReference: payload, createdAt: "2026-11-08T09:00:00.000Z", total: 99, currency: "INR",
    customer: { name: payload, phone: '" autofocus onfocus="alert(1)', email: "customer@example.test", address: payload },
    items: [
      { name: payload, qty: 1, price: 99, lineTotal: 99, image: "javascript:alert(1)" },
      { name: "Legacy image", qty: 1, price: 20, lineTotal: 20, image: "/uploads/candle.jpg" }
    ],
    status: "Placed", paymentStatus: "Pending", paymentAmount: 99, whatsappNotificationStatus: "not_configured"
  };
  await runBrowserScript("public/orders.js", {
    nodes, queryNodes: { "#ordersTable tbody": tbody }, requireAdminPage: async () => true,
    fetchImpl: async () => ({ ok: true, json: async () => [order] })
  });
  assert.equal(tbody.children.length, 1);
  assert.equal(tbody.children[0].children[0].textContent, payload);
  assert.equal(tbody.children[0].children[1].textContent, payload);
  assert.equal(tbody.children[0].children[5].children[0].textContent, "Pending");
  assert.equal(tbody.children[0].children[6].children[0].textContent, "Placed");
  assert.equal(tbody.children[0].innerHTML, "");
  await tbody.children[0].handlers.click({ key: "Enter", preventDefault() {} });
  assert.equal(nodes.orderDetailsView.hidden, false);
  const detailNodes = flattenUi(nodes.orderDetailsContent);
  assert.ok(detailNodes.some(node => node.tagName === "strong" && node.textContent === payload));
  const quantity = detailNodes.find(node => node.className === "order-product-quantity");
  assert.equal(quantity.textContent, "1", "quantity content stays plain so responsive CSS adds the label only once");
  assert.equal(detailNodes.filter(node => node.tagName === "img").length, 1);
  assert.equal(detailNodes.find(node => node.tagName === "img").src, "/uploads/candle.jpg");
  assert.ok(detailNodes.every(node => !node.innerHTML));
  assert.equal(detailNodes.some(node => node.attributes.onclick), false);
});

test("admin orders responsive styles keep table scrolling contained and switch to cards at 430px", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/style.css"), "utf8");
  assert.match(css, /\.orders-table-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.orders-table\s*\{[^}]*min-width:\s*1000px/s);
  assert.match(css, /@media\s*\(max-width:\s*430px\)[\s\S]*?\.orders-table-scroll\s*\{\s*display:\s*none;[\s\S]*?\.orders-cards\s*\{\s*display:\s*grid;/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.order-details-dialog\s*\{[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh/s);
  assert.equal((css.match(/\.order-product-quantity::before/g) || []).length, 1, "only the mobile layout adds a quantity label");
});

test("admin order details open on mobile cards and keep internal IDs for verified payment, fulfilment, and notification actions", async () => {
  const tbody = uiElement("tbody");
  const nodes = makeOrdersPageNodes();
  const order = {
    orderId: "ORD-internal-123", publicReference: "AC-FHS7L", status: "Placed", createdAt: "2026-11-08T09:00:00.000Z",
    customer: { name: "Mani First", phone: "+91 91903 690865", email: "mani@example.test", address: "Bengaluru" },
    items: [{ name: "Bracelet", qty: 1, price: 99, lineTotal: 99 }],
    total: 99, paymentAmount: 99, currency: "INR", paymentStatus: "Pending", paymentMethod: "UPI",
    whatsappNotificationStatus: "failed", customerWhatsAppOptIn: true,
    whatsappOutbox: [{ key: "event-key-1", type: "customer_order", status: "failed", attempts: 1 }],
    statusHistory: [{ status: "Placed", at: "2026-11-08T09:00:00.000Z" }]
  };
  const requests = [];
  const browser = await runBrowserScript("public/orders.js", {
    nodes, queryNodes: { "#ordersTable tbody": tbody }, requireAdminPage: async () => true,
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || "GET", body });
      if (url === "/api/admin/orders/ORD-internal-123/payment-verification" && body.action === "verify") {
        order.paymentStatus = "Paid"; order.status = "Preparing";
      }
      if (url === "/api/orders/ORD-internal-123") order.status = body.status;
      return { ok: true, json: async () => url === "/api/orders" ? [order] : { status: "sent" } };
    }
  });
  assert.equal(tbody.children[0].children[0].textContent, "AC-FHS7L");
  assert.equal(tbody.children[0].children[3].textContent, "1 item");
  assert.equal(nodes.ordersCards.children.length, 1);
  await nodes.ordersCards.children[0].handlers.click();
  assert.equal(nodes.orderDetailsView.hidden, false);
  assert.equal(browser.document.body.classList.contains("order-details-open"), true);

  let controls = flattenUi(nodes.orderDetailsContent);
  const utr = controls.find(node => node.tagName === "input");
  utr.value = "UTR-TEST-123";
  const verify = controls.find(node => node.tagName === "button" && node.textContent === "Verify payment");
  await verify.handlers.click();
  assert.ok(requests.some(request => request.url === "/api/admin/orders/ORD-internal-123/payment-verification" && request.method === "PUT" && request.body.paymentReference === "UTR-TEST-123"));
  controls = flattenUi(nodes.orderDetailsContent);
  assert.ok(controls.some(node => node.textContent === "Paid"), "successful server verification updates the payment display");
  const statusSelect = controls.find(node => node.tagName === "select");
  statusSelect.value = "Shipped";
  const updateStatusButton = controls.find(node => node.tagName === "button" && node.textContent === "Update status");
  await updateStatusButton.handlers.click();
  assert.ok(requests.some(request => request.url === "/api/orders/ORD-internal-123" && request.method === "PUT" && request.body.status === "Shipped"));

  controls = flattenUi(nodes.orderDetailsContent);
  const retryButtons = controls.filter(node => node.tagName === "button" && node.textContent === "Retry");
  const retryAdmin = retryButtons[0];
  await retryAdmin.handlers.click();
  controls = flattenUi(nodes.orderDetailsContent);
  const retryCustomer = controls.filter(node => node.tagName === "button" && node.textContent === "Retry")[1];
  await retryCustomer.handlers.click();
  assert.ok(requests.some(request => request.url === "/api/admin/orders/ORD-internal-123/whatsapp-notification/retry" && request.method === "POST"));
  assert.ok(requests.some(request => request.url === "/api/admin/orders/ORD-internal-123/notifications/event-key-1/retry" && request.method === "POST"));

  await nodes.closeOrderDetails.handlers.click();
  assert.equal(nodes.orderDetailsView.hidden, true);
  assert.equal(browser.document.body.classList.contains("order-details-open"), false);
  assert.equal(nodes.ordersCards.children[0].focused, true, "closing details returns focus to its opener");
  await nodes.ordersCards.children[0].handlers.click();
  browser.document.handlers.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(nodes.orderDetailsView.hidden, true, "Escape closes the details view");
});
test("admin order management has clear empty and API failure states", async () => {
  const tbody = uiElement("tbody");
  const emptyNodes = makeOrdersPageNodes();
  await runBrowserScript("public/orders.js", {
    nodes: emptyNodes, queryNodes: { "#ordersTable tbody": tbody }, requireAdminPage: async () => true,
    fetchImpl: async () => ({ ok: true, json: async () => [] })
  });
  assert.equal(tbody.children[0].children[0].textContent, "No matching orders.");
  assert.equal(emptyNodes.ordersCards.children[0].textContent, "No matching orders.");

  const failureBody = uiElement("tbody");
  const failureNodes = makeOrdersPageNodes();
  await runBrowserScript("public/orders.js", {
    nodes: failureNodes, queryNodes: { "#ordersTable tbody": failureBody }, requireAdminPage: async () => true,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) })
  });
  assert.equal(failureNodes.ordersCards.children[0].textContent, "Orders are temporarily unavailable. Please refresh.");
});
test("customer tracking page renders safe order details, payment state and an evidence-based timeline", async () => {
  const ids = ["orderLookupForm", "orderLookupFeedback", "orderLookupButton", "orderLookupResult", "orderReferenceInput", "orderPhoneInput", "trackedOrderReference", "trackedOrderDate", "trackedPaymentStatus", "trackedFulfilmentStatus", "trackedPaymentPanel", "trackedPaymentMessage", "trackedAmountDue", "trackedQrStatus", "trackedQrImage", "trackedPayeeName", "trackedUpiId", "trackedPayButton", "trackedSharePayment", "trackedContactLink", "trackedOrderItems", "trackedOrderTotal", "trackedOrderTimeline", "trackedTimelineEmpty"];
  const nodes = Object.fromEntries(ids.map(id => [id, uiElement(id)]));
  nodes.orderLookupResult.hidden = true;
  nodes.trackedPaymentPanel.hidden = true;
  nodes.trackedQrImage.hidden = true;
  nodes.trackedPayButton.hidden = true;
  nodes.trackedSharePayment.hidden = true;
  nodes.trackedContactLink.hidden = true;
  nodes.orderReferenceInput.value = "AC-7K2P9";
  nodes.orderPhoneInput.value = "9876543210";
  const payment = await createUpiPaymentDetails({ publicReference: "AC-7K2P9", paymentStatus: "Pending", paymentAmount: 120 }, {
    env: { UPI_ID: "art.corner@bank", UPI_PAYEE_NAME: "Art Corner" }, qrCode: { toDataURL: async () => "data:image/png;base64,cXJjb2Rl" }
  });
  let lookupData = {
    publicReference: "AC-7K2P9", orderDate: "2026-10-01T10:00:00.000Z", status: "Placed", paymentStatus: "Pending", paymentAmount: 120, total: 120, currency: "INR",
    items: [{ name: '<img src=x onerror="alert(1)">', qty: 1, price: 120, lineTotal: 120, image: "/uploads/candle.jpg" }],
    timeline: [{ type: "fulfilment", status: "Placed", at: "2026-10-01T10:00:00.000Z" }], upiPayment: payment,
    sharePaymentDetailsUrl: "https://wa.me/919380125087?text=Pay", contactWhatsAppUrl: "https://wa.me/919380125087?text=Ask"
  };
  const browser = await runBrowserScript("public/track-order.js", {
    nodes,
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).phone, "9876543210");
      return { ok: true, json: async () => lookupData };
    }
  });
  await nodes.orderLookupForm.handlers.submit({ preventDefault() {} });
  assert.equal(nodes.orderLookupResult.hidden, false);
  assert.equal(nodes.trackedOrderReference.textContent, "AC-7K2P9");
  assert.equal(nodes.trackedPaymentStatus.textContent, "Pending");
  assert.equal(nodes.trackedFulfilmentStatus.textContent, "Placed");
  assert.equal(nodes.trackedPaymentPanel.hidden, false);
  assert.equal(nodes.trackedPayButton.href, payment.uri);
  assert.equal(nodes.trackedSharePayment.hidden, false);
  assert.equal(nodes.trackedContactLink.hidden, false);
  const item = nodes.trackedOrderItems.children[0];
  assert.equal(item.children[1].children[0].textContent, '<img src=x onerror="alert(1)">');
  assert.equal(item.innerHTML, "");
  assert.equal(item.children[0].src, "/uploads/candle.jpg");
  assert.equal(nodes.trackedOrderTimeline.children[0].children[1].dateTime, "2026-10-01T10:00:00.000Z");
  assert.equal(nodes.trackedOrderTotal.textContent, "₹120.00 INR");
  assert.equal(browser.window.location.href, "");
  lookupData = { ...lookupData, paymentStatus: "Verification Pending", upiPayment: null };
  await nodes.orderLookupForm.handlers.submit({ preventDefault() {} });
  assert.equal(nodes.trackedPaymentPanel.hidden, false);
  assert.match(nodes.trackedPaymentMessage.textContent, /do not pay again/i);
  assert.equal(nodes.trackedPayButton.hidden, true);
  assert.equal(nodes.trackedSharePayment.hidden, false, "opted-in customers may share their reference while verification is pending");
});
test("category management page lists and creates categories", async () => {
  const nodes = {
    categoriesList: uiElement(), categoryFeedback: uiElement("p"), createCategoryForm: uiElement("form"),
    createCategoryButton: uiElement("button"), categoryName: uiElement("input")
  };
  let categories = legacyCategoryFixtures.map(category => ({ ...category }));
  await runBrowserScript("public/categories.js", {
    nodes,
    fetchImpl: async (url, options = {}) => {
      if (url === "/api/categories" && options.method === "POST") {
        if (JSON.parse(options.body).name === "Candles") {
          return { ok: false, json: async () => ({ error: "A category with that name already exists" }) };
        }
        categories.push({ id: 4, name: JSON.parse(options.body).name });
        return { ok: true, json: async () => ({ category: categories.at(-1) }) };
      }
      return { ok: true, json: async () => categories };
    },
    requireAdminPage: async () => true
  });
  assert.equal(nodes.categoriesList.children.length, 3);
  assert.match(nodes.categoriesList.children[0].children[1].textContent, /ID: 1/);
  nodes.categoryName.value = "Pottery";
  await nodes.createCategoryForm.handlers.submit({ preventDefault() {} });
  assert.equal(nodes.categoriesList.children.length, 4);
  assert.match(nodes.categoryFeedback.textContent, /Pottery was created/);
  nodes.categoryName.value = "Candles";
  await nodes.createCategoryForm.handlers.submit({ preventDefault() {} });
  assert.match(nodes.categoryFeedback.textContent, /already exists/i);
  assert.equal(nodes.categoryFeedback.attributes.role, "alert");
});
test("category management page displays an empty-category state", async () => {
  const nodes = {
    categoriesList: uiElement(), categoryFeedback: uiElement("p"), createCategoryForm: uiElement("form"),
    createCategoryButton: uiElement("button"), categoryName: uiElement("input")
  };
  await runBrowserScript("public/categories.js", {
    nodes,
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
    requireAdminPage: async () => true
  });
  assert.match(nodes.categoriesList.children[0].textContent, /No categories yet/i);
  assert.equal(nodes.categoriesList.children[0].attributes.role, "status");
});
test("category management renames, confirms deletion, and reports API failures", async () => {
  const nodes = {
    categoriesList: uiElement(), categoryFeedback: uiElement("p"), createCategoryForm: uiElement("form"),
    createCategoryButton: uiElement("button"), categoryName: uiElement("input")
  };
  let categories = [...legacyCategoryFixtures.map(category => ({ ...category })), { id: 4, name: "Pottery" }];
  const requests = [];
  await runBrowserScript("public/categories.js", {
    nodes,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === "PUT") {
        categories[3].name = JSON.parse(options.body).name;
        return { ok: true, json: async () => ({ category: categories[3] }) };
      }
      if (options.method === "DELETE") {
        categories = categories.filter(category => category.id !== 4);
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => categories };
    },
    requireAdminPage: async () => true,
    confirmImpl: () => true
  });
  const card = nodes.categoriesList.children[3];
  await card.children[2].children[0].handlers.click();
  const renameForm = card.children.at(-1);
  renameForm.children[0].children[0].value = "Pottery Art";
  await renameForm.handlers.submit({ preventDefault() {} });
  assert.equal(requests.find(request => request.options.method === "PUT").url, "/api/categories/4");
  assert.equal(nodes.categoriesList.children[3].children[0].textContent, "Pottery Art");
  await nodes.categoriesList.children[3].children[2].children[1].handlers.click();
  assert.ok(requests.some(request => request.options.method === "DELETE" && request.url === "/api/categories/4"));
  assert.equal(nodes.categoriesList.children.length, 3);
  assert.match(nodes.categoryFeedback.textContent, /Pottery Art was deleted/);

  const failedNodes = {
    categoriesList: uiElement(), categoryFeedback: uiElement("p"), createCategoryForm: uiElement("form"),
    createCategoryButton: uiElement("button"), categoryName: uiElement("input")
  };
  await runBrowserScript("public/categories.js", {
    nodes: failedNodes,
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "Category service unavailable" }) }),
    requireAdminPage: async () => true
  });
  assert.equal(failedNodes.categoriesList.children[0].attributes.role, "alert");
  assert.match(failedNodes.categoryFeedback.textContent, /service unavailable/i);
});
test("product management has no category mutation controls and dashboard links to category page", () => {
  const adminHtml = fs.readFileSync(path.join(__dirname, "../public/admin.html"), "utf8");
  assert.match(adminHtml, /id="category"/);
  assert.doesNotMatch(adminHtml, /createCategoryForm|categoryName|Create Category|Rename Category|Delete Category/);
  const dashboardHtml = fs.readFileSync(path.join(__dirname, "../public/dashboard.html"), "utf8");
  assert.match(dashboardHtml, /href="categories\.html"[\s\S]*Category Management/);
});
test("admin category dropdown reports the empty-state and links to category management", async () => {
  const nodes = { products: uiElement(), category: uiElement("select"), categoryFeedback: uiElement("p") };
  await runBrowserScript("public/admin.js", {
    nodes,
    fetchImpl: async url => ({ ok: true, json: async () => url === "/api/categories" ? [] : [] }),
    requireAdminPage: async () => true
  });
  assert.match(nodes.category.children[0].textContent, /manage categories/i);
  assert.match(nodes.categoryFeedback.textContent, /Category Management page/i);
});
test("category rename and delete require an authenticated trusted-origin request", async () => {
  const extraCategory = { id: 4, name: "Pottery", normalizedName: "pottery", image: null };
  await withCategoryMocks(async records => withHttpApp(async ({ request }) => {
    records.push({ ...extraCategory });
    const body = JSON.stringify({ name: "Clay Art" });
    assert.equal((await request("/api/categories/4", { method: "PUT", body, headers: { "Content-Type": "application/json" } })).response.status, 401);
    assert.equal((await request("/api/categories/4", { method: "DELETE" })).response.status, 401);

    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    assert.equal((await request("/api/categories/4", { method: "PUT", cookie, origin: "https://evil.example.test", body, headers: { "Content-Type": "application/json" } })).response.status, 403);
    assert.equal((await request("/api/categories/4", { method: "DELETE", cookie, origin: "https://evil.example.test" })).response.status, 403);

    const renamed = await request("/api/categories/4", { method: "PUT", cookie, body, headers: { "Content-Type": "application/json" } });
    assert.equal(renamed.response.status, 200);
    assert.equal(JSON.parse(renamed.text).category.id, 4);
    assert.equal(JSON.parse(renamed.text).category.name, "Clay Art");
    assert.equal((await request("/api/categories/4", { method: "PUT", cookie, body: JSON.stringify({ name: " candles " }), headers: { "Content-Type": "application/json" } })).response.status, 409);
    assert.equal((await request("/api/categories/4", { method: "PUT", cookie, body: JSON.stringify({ name: "  " }), headers: { "Content-Type": "application/json" } })).response.status, 400);
    assert.equal((await request("/api/categories/not-a-number", { method: "DELETE", cookie })).response.status, 400);
  }));
});
test("an empty non-legacy category can be deleted without recycling its ID", async () => {
  const extraCategory = { id: 4, name: "Pottery", normalizedName: "pottery", image: null };
  await withCategoryMocks(async records => withHttpApp(async ({ request }) => {
    records.push({ ...extraCategory });
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const response = await request("/api/categories/4", { method: "DELETE", cookie: sessionCookie(login.setCookies) });
    assert.equal(response.response.status, 200);
    assert.equal(records.some(category => category.id === 4), false);
  }), legacyCategoryFixtures, [1, 2, 3]);
});
test("category deletion is blocked for legacy categories and categories assigned to products", async () => {
  const extraCategory = { id: 4, name: "Pottery", normalizedName: "pottery", image: null };
  await withCategoryMocks(async records => withHttpApp(async ({ request }) => {
    records.push({ ...extraCategory });
    const login = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "test-only-password" })
    });
    const cookie = sessionCookie(login.setCookies);
    const legacy = await request("/api/categories/1", { method: "DELETE", cookie });
    assert.equal(legacy.response.status, 409);
    const assigned = await request("/api/categories/4", { method: "DELETE", cookie });
    assert.equal(assigned.response.status, 409);
    assert.match(JSON.parse(assigned.text).error, /out-of-stock products/i);
    assert.ok(records.some(category => category.id === 4));
  }), legacyCategoryFixtures, [1, 2, 3, 4]);
});
test("admin UI continues to load the protected product-list API", async () => {
  const nodes = {
    products: uiElement(), category: uiElement("select"), categoryFeedback: uiElement("p")
  };
  const requested = [];
  await runBrowserScript("public/admin.js", {
    nodes,
    fetchImpl: async url => {
      requested.push(url);
      if (url === "/api/categories") return { ok: true, json: async () => legacyCategoryFixtures };
      if (url === "/api/admin/products") return { ok: true, json: async () => [{
        _id: "product-1", name: "Candle", price: 250, image: "/uploads/candle.jpg", inStock: false, customizationEnabled: false
      }] };
      if (url === "/api/products/product-1") return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
    requireAdminPage: async () => true
  });
  assert.ok(requested.includes("/api/admin/products"));
  assert.equal(nodes.products.children.length, 1);
  assert.equal(nodes.products.children[0].children.find(child => child.tagName === "p" && child.textContent === "Out of Stock").textContent, "Out of Stock");
  const source = fs.readFileSync(path.join(__dirname, "../public/admin.html"), "utf8");
  assert.match(source, /id="customizationEnabled"/);
  const checkbox = nodes.products.children[0].children.find(child => child.className === "admin-product-customization").children[0];
  assert.equal(checkbox.checked, false, "existing products default to customization disabled");
  checkbox.checked = true;
  checkbox.handlers.change();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(requested.includes("/api/products/product-1"));
});
test("HTTP CORS only names the configured storefront and does not enable credentials", async () => {
  await withCategoryMocks(async () => withHttpApp(async ({ request }) => {
    const trusted = await request("/api/categories");
    assert.equal(trusted.response.headers.get("access-control-allow-origin"), testOrigin);
    assert.equal(trusted.response.headers.get("access-control-allow-credentials"), null);
    const untrusted = await request("/api/categories", { origin: "https://untrusted.example.test" });
    assert.notEqual(untrusted.response.headers.get("access-control-allow-origin"), "https://untrusted.example.test");
  }));
});
test("HTTP login rate limit applies only to login requests", async () => {
  await withCategoryMocks(async () => withHttpApp(async ({ request }) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await request("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-admin", password: "wrong-password" })
      });
      assert.equal(result.response.status, 401, `login attempt ${attempt}`);
    }
    const limited = await request("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password: "wrong-password" })
    });
    assert.equal(limited.response.status, 429);
    const unrelated = await request("/api/categories");
    assert.equal(unrelated.response.status, 200);
  }));
});


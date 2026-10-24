const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const http = require("node:http");
const { randomBytes, scryptSync } = require("node:crypto");
const session = require("express-session");
const cookieSignature = require("cookie-signature");
process.env.NODE_ENV = "test";
const { app, Product, Order, Category, CategoryCounter, createApp, seedLegacyCategories, validateProductionConfig, sessionCookieName } = require("../server");

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
async function invoke(handler, { params = {}, body = {}, file, reqSession = {} } = {}) {
  const result = { statusCode: 200, body: undefined, clearedCookie: null, ended: false };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(value) { result.body = value; return this; },
    clearCookie(name, options) { result.clearedCookie = { name, options }; return this; },
    end() { result.ended = true; return this; }
  };
  await handler({ params, body, file, session: reqSession }, res);
  return result;
}
const testSalt = randomBytes(16);
const testPasswordHash = `scrypt$${testSalt.toString("hex")}$${scryptSync("test-only-password", testSalt, 64).toString("hex")}`;
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
async function withHttpApp(callback) {
  const store = new session.MemoryStore();
  const httpApp = createApp({
    sessionStore: store,
    sessionSecret: testSessionSecret,
    adminUsername: "test-admin",
    adminPasswordHash: testPasswordHash,
    production: true,
    storefrontOrigin: testOrigin
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
function checkoutBrowser({ search = "", cart = [{ _id: "p1", name: "Sample", qty: 1 }], fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ orderId: "ORD-123e4567-e89b-42d3-a456-426614174000" }) }) } = {}) {
  const storage = new Map();
  if (cart !== undefined) storage.set("cart", JSON.stringify(cart));
  const nodes = {
    checkoutForm: { hidden: false, onsubmit: null, querySelector: () => ({ disabled: false }) },
    checkoutFeedback: { textContent: "" },
    orderConfirmation: { hidden: true },
    orderConfirmationId: { textContent: "" },
    name: { value: "A Customer" }, phone: { value: "9876543210" },
    email: { value: "customer@example.com" }, address: { value: "Bengaluru" }
  };
  const window = { history: { back() {}, replaceState(_state, _title, url) { this.replacedUrl = url; } }, location: { search, href: "" } };
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    removeItem: key => storage.delete(key)
  };
  const document = { getElementById: id => nodes[id] };
  const source = fs.readFileSync(path.join(__dirname, "../public/checkout.js"), "utf8");
  vm.runInNewContext(source, { document, window, localStorage, fetch: fetchImpl, console, URLSearchParams });
  return { nodes, window, storage };
}
function uiElement(tagName = "div") {
  return {
    tagName,
    children: [],
    handlers: {},
    attributes: {},
    className: "",
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    set innerHTML(value) { this._innerHTML = value; this.children = []; },
    get innerHTML() { return this._innerHTML || ""; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    reset() { this.resetCalled = true; },
    focus() { this.focused = true; },
    remove() { this.removed = true; },
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || null; }
  };
}
async function runBrowserScript(relativePath, { nodes = {}, fetchImpl, search = "", requireAdminPage, confirmImpl = () => true } = {}) {
  const window = { history: { back() {}, replaceState(_state, _title, url) { this.replacedUrl = url; } }, location: { search, href: "" } };
  const document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => uiElement(tag)
  };
  const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  vm.runInNewContext(source, {
    document, window: { ...window, confirm: confirmImpl }, fetch: fetchImpl, console, URLSearchParams,
    encodeURIComponent, requireAdminPage, Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    FormData: class { append() {} }, alert() {}
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { window, nodes };
}

test("GET /api/products queries only in-stock products", async () => {
  stub(Product, "find", async filter => {
    assert.deepEqual(filter, { inStock: true });
    return [{ _id: "p1", name: "Sample", inStock: true }];
  });
  const handlers = routeStack("get", "/api/products");
  const response = await invoke(handlers.at(-1));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, [{ _id: "p1", name: "Sample", inStock: true }]);
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
  const response = await invoke(routeStack("put", "/api/orders/:id").at(-1), { body: { status: "Cancelled" } });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Status must be/);
});
test("POST /api/orders returns a persisted order ID in a success response", async () => {
  const originalSave = Order.prototype.save;
  Order.prototype.save = async function () { return this; };
  try {
    const response = await invoke(routeStack("post", "/api/orders").at(-1), {
      body: { customer: { name: "A Customer" }, items: [{ name: "Sample", price: 250, qty: 1 }] }
    });
    assert.equal(response.statusCode, 201);
    assert.match(response.body.orderId, /^ORD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  } finally {
    Order.prototype.save = originalSave;
  }
});
test("checkout clears cart only after a confirmed response and redirects to the confirmation URL", async () => {
  const browser = checkoutBrowser();
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(browser.storage.has("cart"), false);
  assert.match(browser.window.location.href, /^checkout\.html\?orderId=ORD-/);
});
test("checkout failure preserves cart and shows an error", async () => {
  const browser = checkoutBrowser({ fetchImpl: async () => ({ ok: false, json: async () => ({ error: "Order save failed" }) }) });
  await browser.nodes.checkoutForm.onsubmit({ preventDefault() {} });
  assert.equal(browser.storage.has("cart"), true);
  assert.match(browser.nodes.checkoutFeedback.textContent, /Order save failed/);
});
test("refreshing an order confirmation shows the ID without attaching a submit handler", () => {
  const orderId = "ORD-123e4567-e89b-42d3-a456-426614174000";
  const browser = checkoutBrowser({ search: `?orderId=${orderId}`, cart: undefined, fetchImpl: async () => { throw new Error("unexpected request"); } });
  assert.equal(browser.nodes.orderConfirmation.hidden, false);
  assert.equal(browser.nodes.orderConfirmationId.textContent, orderId);
  assert.equal(browser.nodes.checkoutForm.hidden, true);
  assert.equal(browser.nodes.checkoutForm.onsubmit, null);
});

test("production configuration requires explicit production mode and a valid storefront origin", () => {
  const valid = {
    NODE_ENV: "production", MONGO_URI: "mongodb://test.invalid/db", SESSION_SECRET: "x".repeat(40),
    ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD_HASH: testPasswordHash, STOREFRONT_ORIGIN: "https://storefront.example.test"
  };
  assert.doesNotThrow(() => validateProductionConfig(valid));
  assert.throws(() => validateProductionConfig({ ...valid, NODE_ENV: undefined }), /NODE_ENV must be explicitly/);
  assert.throws(() => validateProductionConfig({ ...valid, STOREFRONT_ORIGIN: undefined }), /STOREFRONT_ORIGIN/);
  assert.throws(() => validateProductionConfig({ ...valid, STOREFRONT_ORIGIN: "http://storefront.example.test" }), /HTTPS origin/);
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
    for (const [method, routePath] of [["POST", "/api/products"], ["DELETE", "/api/products/not-an-id"], ["PUT", "/api/products/not-an-id"], ["GET", "/api/orders"], ["PUT", "/api/orders/ORD-test"]]) {
      const result = await request(routePath, { method });
      assert.equal(result.response.status, 401, `${method} ${routePath}`);
      assert.match(result.text, /Authentication required/);
    }
  });
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
      const logout = await request("/api/admin/logout", { method: "POST", cookie });
      assert.equal(logout.response.status, 204);
      assert.match(logout.setCookies.join(";"), /artcorner\.sid=;/);
      const afterLogout = await request("/api/orders", { cookie });
      assert.equal(afterLogout.response.status, 401);
    } finally {
      Order.find = originalFind;
    }
  });
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
    for (const [method, routePath] of [["POST", "/api/products"], ["DELETE", "/api/products/invalid"], ["PUT", "/api/products/invalid"], ["PUT", "/api/orders/ORD-test"], ["POST", "/api/admin/logout"]]) {
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
    const result = await invoke(routeStack("post", "/api/products").at(-1), {
      body: { name: "Sample", price: "10", categoryId: "99" }, file: { filename: "test.jpg" }
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
  try {
    const result = await invoke(routeStack("post", "/api/products").at(-1), {
      body: { name: "Sample", price: "10", categoryId: "1" }, file: { filename: "test.jpg" }
    });
    assert.equal(result.statusCode, 201);
    assert.equal(released, true);
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
test("homepage category UI renders text tabs without category images and keeps All Products on API failure", async () => {
  const categories = [{ id: 1, name: "Candles", image: "/uploads/candle.jpg" }, { id: 4, name: "Pottery", image: null }];
  const tabs = uiElement("nav");
  const success = await runBrowserScript("public/script.js", {
    nodes: { categories: tabs },
    fetchImpl: async () => ({ ok: true, json: async () => categories })
  });
  assert.deepEqual(success.nodes.categories.children.map(tab => tab.textContent), ["All Products", "Candles", "Pottery"]);
  assert.equal(success.nodes.categories.children.some(tab => tab.tagName === "img"), false);
  const failedTabs = uiElement("nav");
  const failed = await runBrowserScript("public/script.js", {
    nodes: { categories: failedTabs },
    fetchImpl: async () => ({ ok: false })
  });
  assert.equal(failed.nodes.categories.children[0].textContent, "All Products");
  assert.match(failed.nodes.categories.children.at(-1).textContent, /still browse all products/i);
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
        _id: "product-1", name: "Candle", price: 250, image: "/uploads/candle.jpg", inStock: false
      }] };
      return { ok: true, json: async () => ({}) };
    },
    requireAdminPage: async () => true
  });
  assert.ok(requested.includes("/api/admin/products"));
  assert.equal(nodes.products.children.length, 1);
  assert.match(nodes.products.children[0].innerHTML, /Out of Stock/);
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


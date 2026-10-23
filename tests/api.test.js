const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");
const session = require("express-session");
const cookieSignature = require("cookie-signature");
process.env.NODE_ENV = "test";
const { app, Product, Order, createApp, validateProductionConfig, sessionCookieName } = require("../server");

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
    const response = await fetch(`${baseUrl}${routePath}`, { method, headers: requestHeaders, body });
    return { response, setCookies: response.headers.getSetCookie(), text: await response.text() };
  }
  try {
    await callback({ store, request });
  } finally {
    await new Promise(resolve => server.close(resolve));
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
  const window = { history: { back() {} }, location: { search, href: "" } };
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    removeItem: key => storage.delete(key)
  };
  const document = { getElementById: id => nodes[id] };
  const source = fs.readFileSync(path.join(__dirname, "../public/checkout.js"), "utf8");
  vm.runInNewContext(source, { document, window, localStorage, fetch: fetchImpl, console, URLSearchParams });
  return { nodes, window, storage };
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
test("HTTP CORS only names the configured storefront and does not enable credentials", async () => {
  await withHttpApp(async ({ request }) => {
    const trusted = await request("/api/categories");
    assert.equal(trusted.response.headers.get("access-control-allow-origin"), testOrigin);
    assert.equal(trusted.response.headers.get("access-control-allow-credentials"), null);
    const untrusted = await request("/api/categories", { origin: "https://untrusted.example.test" });
    assert.notEqual(untrusted.response.headers.get("access-control-allow-origin"), "https://untrusted.example.test");
  });
});
test("HTTP login rate limit applies only to login requests", async () => {
  await withHttpApp(async ({ request }) => {
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
  });
});


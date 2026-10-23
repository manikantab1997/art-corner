const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { app, Product, Order } = require("../server");

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
function route(method, path) {
  const layer = app.router.stack.find(item => item.route?.path === path && item.route.methods[method.toLowerCase()]);
  assert.ok(layer, `${method} ${path} route exists`);
  return layer.route.stack.at(-1).handle;
}
async function invoke(handler, { params = {}, body = {}, file } = {}) {
  const result = { statusCode: 200, body: undefined };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(value) { result.body = value; return this; }
  };
  await handler({ params, body, file }, res);
  return result;
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
  const response = await invoke(route("get", "/api/products"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, [{ _id: "p1", name: "Sample", inStock: true }]);
  restore();
});
test("POST /api/products returns a clear error for missing name and required fields", async () => {
  const response = await invoke(route("post", "/api/products"));
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Product name is required/);
});
test("POST /api/products rejects missing image after validating product fields", async () => {
  const response = await invoke(route("post", "/api/products"), { body: { name: "Sample item", price: "250", categoryId: "1" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "A product image is required");
});
test("GET /api/product/:id rejects malformed IDs before database access", async () => {
  const response = await invoke(route("get", "/api/product/:id"), { params: { id: "not-an-object-id" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Invalid product ID");
});
test("PUT /api/products/:id rejects malformed IDs before database access", async () => {
  const response = await invoke(route("put", "/api/products/:id"), { params: { id: "bad-id" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Invalid product ID");
});
test("PUT /api/orders/:id validates status before database access", async () => {
  const response = await invoke(route("put", "/api/orders/:id"), { body: { status: "Cancelled" } });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Status must be/);
});
test("POST /api/orders returns a persisted order ID in a success response", async () => {
  const originalSave = Order.prototype.save;
  Order.prototype.save = async function () { return this; };
  try {
    const response = await invoke(route("post", "/api/orders"), {
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


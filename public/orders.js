if (
    localStorage.getItem("isAdmin")
    !== "true"
) {

    window.location.href =
        "login.html";
}
if (localStorage.getItem("isAdmin") !== "true") {
    window.location.href = "login.html";
}
function goBack() {
    window.history.back();
}

let allOrders = [];

async function loadOrders() {
    const res = await fetch("/api/orders");
    allOrders = await res.json();

    renderOrders(allOrders);
}

function renderOrders(orders) {
    const tbody = document.querySelector("#ordersTable tbody");
    tbody.innerHTML = "";

    orders.forEach(order => {
        const tr = document.createElement("tr");

        tr.innerHTML = `
      <td>${order.orderId}</td>
      <td>${order.customer.name}</td>
      <td>${order.customer.phone}</td>
      <td>
        ${order.items.map(item => `
          ${item.name} (x${item.qty})<br>
        `).join("")}
      </td>
      <td>${order.status}</td>
      <td>
        <select onchange="updateStatus('${order.orderId}', this.value)">
          <option ${order.status === "Placed" ? "selected" : ""}>Placed</option>
          <option ${order.status === "Shipped" ? "selected" : ""}>Shipped</option>
          <option ${order.status === "Delivered" ? "selected" : ""}>Delivered</option>
        </select>
      </td>
    `;

        tbody.appendChild(tr);
    });
}

// 🔄 Update status
async function updateStatus(orderId, status) {
    await fetch(`/api/orders/${orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
    });

    alert("Status updated");
    loadOrders();
}

// 🔍 Search + Filter
document.getElementById("search").oninput = filterOrders;
document.getElementById("filter").onchange = filterOrders;

function filterOrders() {
    const search = document.getElementById("search").value.toLowerCase();
    const filter = document.getElementById("filter").value;

    let filtered = allOrders.filter(order => {
        const matchSearch =
            order.orderId.toLowerCase().includes(search) ||
            order.customer.name.toLowerCase().includes(search);

        const matchFilter =
            filter === "all" || order.status === filter;

        return matchSearch && matchFilter;
    });

    renderOrders(filtered);
}

loadOrders();
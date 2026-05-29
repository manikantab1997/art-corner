function login() {
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  // Simple static login (for now)
  if (username === "admin" && password === "1234") {
    localStorage.setItem("isAdmin", "true");
    window.location.href = "dashboard.html";
  } else {
    alert("Invalid credentials");
  }
}
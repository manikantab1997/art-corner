const categoriesList = document.getElementById("categoriesList");
const categoryFeedback = document.getElementById("categoryFeedback");
const createCategoryForm = document.getElementById("createCategoryForm");
const createCategoryButton = document.getElementById("createCategoryButton");

function showCategoryMessage(message, role = "status") {
  categoryFeedback.textContent = message;
  categoryFeedback.setAttribute("role", role);
}

async function responseError(response, fallback) {
  const result = await response.json().catch(() => ({}));
  return result.error || fallback;
}

function categoryCard(category) {
  const card = document.createElement("article");
  card.className = "category-management-item";

  const title = document.createElement("h2");
  title.textContent = category.name;
  const id = document.createElement("p");
  id.className = "category-management-id";
  id.textContent = `Category ID: ${category.id}`;

  const actions = document.createElement("div");
  actions.className = "category-management-actions";
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.textContent = "Rename";
  renameButton.addEventListener("click", () => beginRename(category, card));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "category-delete-button";
  deleteButton.textContent = "Delete";
  deleteButton.disabled = Number(category.id) <= 3;
  deleteButton.title = deleteButton.disabled ? "Original categories cannot be deleted" : "Delete this empty category";
  deleteButton.addEventListener("click", () => deleteCategory(category));
  actions.append(renameButton, deleteButton);
  card.append(title, id, actions);
  return card;
}

async function loadCategories() {
  categoriesList.replaceChildren();
  const loading = document.createElement("p");
  loading.setAttribute("role", "status");
  loading.textContent = "Loading categories…";
  categoriesList.appendChild(loading);

  try {
    const response = await fetch("/api/categories");
    if (!response.ok) throw new Error(await responseError(response, "Categories could not be loaded."));
    const categories = await response.json();
    if (!Array.isArray(categories)) throw new Error("The category response was invalid.");
    categoriesList.replaceChildren();
    if (!categories.length) {
      const empty = document.createElement("p");
      empty.setAttribute("role", "status");
      empty.textContent = "No categories yet. Create one above to get started.";
      categoriesList.appendChild(empty);
      showCategoryMessage("Category list loaded.");
      return categories;
    }
    categories.forEach(category => categoriesList.appendChild(categoryCard(category)));
    showCategoryMessage("Categories loaded.");
    return categories;
  } catch (error) {
    console.error("Category list request failed:", error);
    categoriesList.replaceChildren();
    const failure = document.createElement("p");
    failure.setAttribute("role", "alert");
    failure.textContent = "Categories could not be loaded. Please refresh and try again.";
    categoriesList.appendChild(failure);
    showCategoryMessage(error.message || "Categories could not be loaded.", "alert");
    throw error;
  }
}

function beginRename(category, card) {
  if (card.querySelector(".category-rename-form")) return;
  const form = document.createElement("form");
  form.className = "category-rename-form";
  const label = document.createElement("label");
  label.textContent = "New category name";
  const input = document.createElement("input");
  input.name = "name";
  input.maxLength = 80;
  input.required = true;
  input.value = category.name;
  label.appendChild(input);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save name";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => form.remove());
  form.append(label, save, cancel);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || name.length > 80) {
      showCategoryMessage("Enter a category name of 1 to 80 characters.", "alert");
      return;
    }
    save.disabled = true;
    try {
      const response = await fetch(`/api/categories/${encodeURIComponent(category.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!response.ok) throw new Error(await responseError(response, "Category could not be renamed."));
      await response.json().catch(() => ({}));
      await loadCategories();
      showCategoryMessage(`Category ${category.id} was renamed to ${name}.`);
    } catch (error) {
      showCategoryMessage(error.message || "Category could not be renamed. Please try again.", "alert");
    } finally {
      save.disabled = false;
    }
  });
  card.appendChild(form);
  input.focus();
}

async function deleteCategory(category) {
  if (Number(category.id) <= 3) {
    showCategoryMessage("The original categories cannot be deleted.", "alert");
    return;
  }
  if (!window.confirm(`Delete “${category.name}” (ID ${category.id})? This cannot be undone.`)) return;
  try {
    const response = await fetch(`/api/categories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await responseError(response, "Category could not be deleted."));
    await loadCategories();
    showCategoryMessage(`${category.name} was deleted.`);
  } catch (error) {
    showCategoryMessage(error.message || "Category could not be deleted. Please try again.", "alert");
  }
}

createCategoryForm.addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("categoryName");
  const name = input.value.trim();
  if (!name || name.length > 80) {
    showCategoryMessage("Enter a category name of 1 to 80 characters.", "alert");
    return;
  }
  createCategoryButton.disabled = true;
  try {
    const response = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!response.ok) throw new Error(await responseError(response, "Category could not be created."));
    const result = await response.json();
    await loadCategories();
    createCategoryForm.reset();
    showCategoryMessage(`${result.category.name} was created.`);
  } catch (error) {
    showCategoryMessage(error.message || "Category could not be created. Please try again.", "alert");
  } finally {
    createCategoryButton.disabled = false;
  }
});

requireAdminPage().then(isAdmin => {
  if (isAdmin) loadCategories().catch(() => {});
});

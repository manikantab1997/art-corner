const categoriesContainer = document.getElementById("categories");
const categoriesStatus = document.getElementById("home-category-status");
const productsContainer = document.getElementById("featured-products");
const productsStatus = document.getElementById("home-products-status");
const heroImage = document.getElementById("hero-product-image");
const heroImageCaption = document.getElementById("hero-image-caption");

async function fetchHomeData(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} could not be loaded.`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`The ${label.toLowerCase()} response was invalid.`);
  return data;
}

function isLocalPreviewProduct(product) {
  return typeof product?.name === "string" && product.name.startsWith("[LOCAL PREVIEW] ");
}

function getProductImageSource(product) {
  const savedImage = typeof product?.image === "string" ? product.image.trim() : "";
  if (savedImage.startsWith("/") && !savedImage.startsWith("//") && !savedImage.includes("\\") &&
      !savedImage.split(/[?#]/, 1)[0].split("/").includes("..")) {
    return savedImage;
  }
  if (savedImage) {
    try {
      if (new URL(savedImage).protocol === "https:") return savedImage;
    } catch {
      // Invalid or unsupported image values use the existing placeholder.
    }
  }

  if (isLocalPreviewProduct(product) && Number(product.categoryId) === 1) {
    return "/uploads/candle.jpg";
  }
  return "";
}

function makeCategoryCard({ name, href, product, index, allProducts = false }) {
  const card = document.createElement("a");
  card.className = `category-card${allProducts ? " category-card-all" : ""}`;
  card.href = href;
  card.style.animationDelay = `${Math.min(index, 6) * 65}ms`;

  const visual = document.createElement("span");
  visual.className = "category-card-visual";
  visual.setAttribute("aria-hidden", "true");
  const art = document.createElement("span");
  art.className = "category-card-art";
  visual.appendChild(art);

  const imageSource = getProductImageSource(product);
  if (imageSource) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.hidden = true;
    image.addEventListener("load", () => { image.hidden = false; });
    image.src = imageSource;
    visual.appendChild(image);
  }

  const copy = document.createElement("span");
  copy.className = "category-card-copy";
  const title = document.createElement("span");
  title.className = "category-card-title";
  title.textContent = name;
  const action = document.createElement("span");
  action.className = "category-card-action";
  action.textContent = allProducts ? "Discover the full collection" : "Explore collection";
  copy.append(title, action);
  card.append(visual, copy);
  return card;
}

function renderCategories(categories, products) {
  categoriesContainer.replaceChildren();
  categoriesContainer.appendChild(makeCategoryCard({
    name: "All Products",
    href: "products.html",
    product: products[0],
    index: 0,
    allProducts: true
  }));

  const validCategories = categories.filter(category =>
    category && Number.isInteger(Number(category.id)) && typeof category.name === "string" && category.name.trim()
  );
  validCategories.forEach((category, index) => {
    const representativeProduct = products.find(product => String(product.categoryId) === String(category.id));
    categoriesContainer.appendChild(makeCategoryCard({
      name: category.name,
      href: `products.html?category=${encodeURIComponent(category.id)}`,
      product: representativeProduct,
      index: index + 1
    }));
  });

  categoriesStatus.textContent = validCategories.length
    ? "Choose a collection to find something made for you."
    : "No collections are available right now. You can still shop all products.";
}

function renderFeaturedProducts(products) {
  productsContainer.replaceChildren();
  const featured = products.filter(product => product && product.inStock !== false).slice(0, 4);
  if (!featured.length) {
    productsStatus.textContent = "There are no in-stock products to feature just now. Please check back soon.";
    return;
  }

  productsStatus.textContent = "A few handmade favourites from our current collection.";
  featured.forEach((product, index) => {
    const card = document.createElement("article");
    card.className = "home-product-card";
    card.style.animationDelay = `${index * 70}ms`;

    const link = document.createElement("a");
    link.className = "home-product-image-link";
    link.href = `product.html?id=${encodeURIComponent(product._id)}`;
    link.setAttribute("aria-label", `View ${product.name || "handmade product"}`);

    const isLocalPreview = isLocalPreviewProduct(product);
    const categoryArtwork = {
      1: "candle",
      2: "resin",
      3: "bracelet"
    }[Number(product.categoryId)] || "generic";
    const displayImage = getProductImageSource(product);
    const fallback = document.createElement("span");
    fallback.className = `product-image-placeholder${isLocalPreview ? ` product-artwork product-artwork-${categoryArtwork}` : ""}`;
    if (isLocalPreview) {
      fallback.setAttribute("aria-hidden", "true");
      const artworkObject = document.createElement("span");
      artworkObject.className = "product-artwork-object";
      const artworkLabel = document.createElement("span");
      artworkLabel.className = "product-artwork-label";
      artworkLabel.textContent = "Local preview illustration";
      fallback.append(artworkObject, artworkLabel);
    } else {
      fallback.textContent = product.image ? "Image unavailable" : "Image coming soon";
    }

    if (displayImage) {
      const image = document.createElement("img");
      image.src = displayImage;
      image.alt = product.name || "Handmade product";
      image.loading = "lazy";
      image.hidden = true;
      image.addEventListener("load", () => { image.hidden = false; });
      image.addEventListener("load", () => { fallback.hidden = true; });
      image.addEventListener("error", () => { image.remove(); });
      link.appendChild(image);
      link.appendChild(fallback);
    } else {
      link.appendChild(fallback);
    }

    const details = document.createElement("div");
    details.className = "home-product-details";
    const name = document.createElement("h3");
    name.textContent = product.name || "Handmade piece";
    const price = document.createElement("p");
    price.className = "home-product-price";
    price.textContent = `₹${product.price}`;
    details.append(name, price);
    card.append(link, details);
    productsContainer.appendChild(card);
  });
}

async function loadHomePage() {
  const [categoryResult, productResult] = await Promise.allSettled([
    fetchHomeData("/api/categories", "Categories"),
    fetchHomeData("/api/products", "Products")
  ]);
  const products = productResult.status === "fulfilled"
    ? productResult.value.filter(product => product && product.inStock === true)
    : [];

  if (productResult.status === "fulfilled") {
    renderFeaturedProducts(products);
    const heroImageSource = getProductImageSource(products[0]);
    if (heroImageSource) {
      heroImage.addEventListener("load", () => { heroImage.hidden = false; });
      heroImage.src = heroImageSource;
      if (products[0].name) heroImageCaption.textContent = products[0].name;
    }
  } else {
    console.error("Featured product request failed:", productResult.reason);
    productsStatus.textContent = "Products are temporarily unavailable. Please try again shortly.";
  }

  if (categoryResult.status === "fulfilled") {
    renderCategories(categoryResult.value, products);
  } else {
    console.error("Category request failed:", categoryResult.reason);
    categoriesContainer.replaceChildren(makeCategoryCard({
      name: "All Products",
      href: "products.html",
      product: products[0],
      index: 0,
      allProducts: true
    }));
    categoriesStatus.textContent = "Collections are temporarily unavailable. You can still browse all products.";
  }
}

loadHomePage();

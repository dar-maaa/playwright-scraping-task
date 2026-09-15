const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PRODUCT_URL =
  "https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI";

const OUTPUT_PATH = path.join(__dirname, "..", "output", "product.json");

// Headless Chromium sends HeadlessChrome Client Hints; Akamai blocks that.
// A normal Chrome UA + sec-ch-ua* on the context is enough to pass.
const CHROME_VERSION = "153";
const USER_AGENT =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

const CHROME_HEADERS = {
  "sec-ch-ua":
    `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

function parsePrice(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function normalizeAvailability(text) {
  if (!text) return null;
  const value = text.toLowerCase();
  if (/pre[-\s]?order/.test(value)) return "pre_order";
  if (/out\s*of\s*stock|sold\s*out|unavailable|notify\s*me/.test(value)) {
    return "out_of_stock";
  }
  if (/in\s*stock|add\s*to\s*cart|available/.test(value)) return "in_stock";
  return null;
}

async function acceptCookies(page) {
  const button = page.locator("#ccc-notify-accept");
  try {
    await button.click({ timeout: 8000 });
  } catch {
    // Banner may already be dismissed or absent.
  }
}

async function textOf(locator) {
  if ((await locator.count()) === 0) return null;
  const text = await locator.first().textContent();
  return text?.trim() || null;
}

async function attrOf(locator, name) {
  if ((await locator.count()) === 0) return null;
  const value = await locator.first().getAttribute(name);
  return value?.trim() || null;
}

async function extractProduct(page) {
  const title = await textOf(page.locator("h2.crop-text-2.title"));
  const description = await textOf(page.locator("h2.crop-text-2.title + div p"));
  const itemId = await attrOf(page.locator('input[name="product_id"]'), "value");
  const pageTitle = await page.title();
  const brand = pageTitle.match(/^([a-z0-9]+)/i)?.[1] || null;

  const priceBox = page.locator("#prices-new").locator("xpath=..");
  const priceText = await textOf(page.locator("#prices-new"));
  const oldPriceText = await textOf(priceBox.locator(".price-old, .prices-old, s, del"));
  const availabilityCandidates = [
    await textOf(priceBox),
    await textOf(page.locator("#product_qty")),
  ];
  const availabilityText =
    availabilityCandidates.find((text) => normalizeAvailability(text) !== null) || null;

  const crumbItems = [];
  const crumbs = page.locator(".breadcrumb li");
  const crumbCount = await crumbs.count();
  for (let i = 0; i < crumbCount; i++) {
    const li = crumbs.nth(i);
    const link = li.locator("a");
    if ((await link.count()) > 0) {
      crumbItems.push({
        name: (await link.textContent())?.trim() || null,
        url: await link.getAttribute("href"),
      });
    } else {
      crumbItems.push({
        name: (await li.textContent())?.trim() || null,
        url: null,
      });
    }
  }

  const categoryTree = crumbItems.filter((item) => {
    if (!item.name || item.name.toLowerCase() === "home") return false;
    if (title && item.name.toLowerCase() === title.toLowerCase()) return false;
    return true;
  });

  const productCategory =
    categoryTree.length > 0 ? categoryTree.map((item) => item.name).join(" > ") : null;

  const imageUrl = await attrOf(page.locator("#imagePopup"), "src");

  const thumbs = await page.locator("#carouselImages img").all();
  const thumbSrcs = await Promise.all(
    thumbs.map((thumb) => thumb.getAttribute("popup_img"))
  );
  const additionalImageUrls = [...new Set(thumbSrcs.filter((src) => src && src !== imageUrl))];

  const specs = [];
  const rows = page.locator("table.table-borderless tr");
  const rowCount = await rows.count();
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const name = await textOf(row.locator("th"));
    if (!name) continue;
    const value = await textOf(row.locator("td"));
    specs.push({ name, value: value === "-" ? null : value });
  }

  const ratingInfo = await textOf(page.locator("#average-rating-info"));
  let starRating = null;
  let reviewCount = null;
  if (ratingInfo) {
    const match = ratingInfo.match(/([\d.]+)\s*\((\d+)\)/);
    if (match) {
      starRating = Number(match[1]);
      reviewCount = Number(match[2]);
    }
  }

  const mpnSpec = specs.find((spec) => /manufacturer\s*number|mpn/i.test(spec.name));
  const gtinSpec = specs.find((spec) => /gtin|upc|ean/i.test(spec.name));

  return {
    itemId,
    title,
    description,
    priceText,
    oldPriceText,
    availabilityText,
    categoryTree,
    productCategory,
    imageUrl,
    additionalImageUrls,
    specs,
    starRating,
    reviewCount,
    mpn: mpnSpec?.value || null,
    gtin: gtinSpec?.value || null,
    brand,
  };
}

function buildProductRecord(raw, pageUrl) {
  const currentPrice = parsePrice(raw.priceText);
  const oldPrice = parsePrice(raw.oldPriceText);

  let price = currentPrice;
  let salePrice = null;

  if (oldPrice != null && currentPrice != null && oldPrice > currentPrice) {
    price = oldPrice;
    salePrice = currentPrice;
  }

  return {
    url: pageUrl,
    item_id: raw.itemId || null,
    title: raw.title || null,
    brand: raw.brand || null,
    product_category: raw.productCategory || null,
    category_tree: raw.categoryTree || [],
    description: raw.description || null,
    price,
    sale_price: salePrice,
    availability: normalizeAvailability(raw.availabilityText),
    image_url: raw.imageUrl || null,
    additional_image_urls: raw.additionalImageUrls || [],
    specs: raw.specs || [],
    star_rating: raw.starRating ?? null,
    review_count: raw.reviewCount ?? null,
    gtin: raw.gtin || null,
    mpn: raw.mpn || null,
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeProduct(url) {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      userAgent: USER_AGENT,
      extraHTTPHeaders: CHROME_HEADERS,
    });
    const page = await context.newPage();

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!response || response.status() >= 400) {
      throw new Error(`Failed to load product page (status ${response?.status() ?? "unknown"})`);
    }

    await acceptCookies(page);
    await page.locator("#prices-new").waitFor({ timeout: 30000 });

    const raw = await extractProduct(page);
    if (!raw.title || !raw.priceText || !raw.imageUrl || raw.specs.length === 0) {
      throw new Error("Required product content was not found");
    }

    return buildProductRecord(raw, page.url());
  } finally {
    await browser.close();
  }
}

function saveOutput(product) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(product, null, 2)}\n`, "utf8");
}

async function main() {
  const product = await scrapeProduct(PRODUCT_URL);
  saveOutput(product);
  console.log(`Saved product data to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Scrape failed:", error.message);
  process.exit(1);
});

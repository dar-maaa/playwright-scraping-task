# MSI Product Scraper

Playwright scraper for the MSI MAG Z890 TOMAHAWK WIFI product page.

## Requirements

- Node.js 20 or newer
- npm

## Run

```bash
npm install
npm run scrape
```

The install script downloads Playwright Chromium. The scraper runs headlessly and writes the
current product data to `output/product.json`.

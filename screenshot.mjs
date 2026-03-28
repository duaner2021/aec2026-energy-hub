import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = path.join(__dirname, 'temporary screenshots');

if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';

// Find next available screenshot number
const existing = fs.readdirSync(screenshotDir).filter(f => f.startsWith('screenshot-'));
let maxN = 0;
for (const f of existing) {
  const match = f.match(/^screenshot-(\d+)/);
  if (match) maxN = Math.max(maxN, parseInt(match[1]));
}
const n = maxN + 1;
const filename = label ? `screenshot-${n}-${label}.png` : `screenshot-${n}.png`;
const outputPath = path.join(screenshotDir, filename);

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: outputPath, fullPage: true });
await browser.close();

console.log(`Screenshot saved: ${outputPath}`);

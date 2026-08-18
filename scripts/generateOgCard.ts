/**
 * Capture an Enhanced still and compose `public/og.png` (1200×630 Open Graph / X card).
 *
 * Requires a running production preview (`npm run build && npm run preview`).
 *
 *   npx vite-node scripts/generateOgCard.ts
 *
 * Uses Playwright's Chromium only — no extra image deps. The still is a real Enhanced frame;
 * the script crops to the share aspect and paints the brand overlay.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/og.png');
const SOURCE_OUT = join(ROOT, 'scripts/assets/og-source.png');
const W = 1200;
const H = 630;

async function main(): Promise<void> {
  const base = process.env.OG_BASE ?? 'http://127.0.0.1:4173';
  mkdirSync(dirname(OUT), { recursive: true });
  mkdirSync(dirname(SOURCE_OUT), { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dbus'],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.goto(`${base}/?test=1&renderer=webgl2&level=level-1&seed=1234`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(() => window.__optimus !== undefined);
  // Level intro card lasts ~2.2s — clear it before posing so the share card is not cluttered.
  await page.evaluate(() => {
    window.__optimus?.pauseDriver();
    window.__optimus?.stepFrames(150);
  });
  await page.evaluate(() => {
    window.__optimus?.resumeDriver();
  });
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1100);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    window.__optimus?.pauseDriver();
  });

  await page.locator('canvas#screen').screenshot({ path: SOURCE_OUT, type: 'png' });
  const sourceDataUrl = `data:image/png;base64,${readFileSync(SOURCE_OUT).toString('base64')}`;

  const png = await page.evaluate(
    async ({ sourceDataUrl: dataUrl, width, height }) => {
      const img = new Image();
      img.decoding = 'async';
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('failed to load og source'));
      });
      img.src = dataUrl;
      await loaded;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2d context unavailable');

      const scale = Math.max(width / img.width, height / img.height) * 1.08;
      const nw = img.width * scale;
      const nh = img.height * scale;
      const left = Math.max(0, Math.min((nw - width) / 2 - 40, nw - width));
      const top = Math.max(0, Math.min((nh - height) * 0.42, nh - height));

      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, -left, -top, nw, nh);

      ctx.fillStyle = 'rgba(5, 7, 12, 0.28)';
      ctx.fillRect(0, 0, width, height);

      const wash = ctx.createLinearGradient(0, 0, 620, 0);
      wash.addColorStop(0, 'rgba(5, 7, 12, 0.92)');
      wash.addColorStop(1, 'rgba(5, 7, 12, 0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, 620, height);

      const bottom = ctx.createLinearGradient(0, height - 160, 0, height);
      bottom.addColorStop(0, 'rgba(5, 7, 12, 0)');
      bottom.addColorStop(1, 'rgba(5, 7, 12, 0.58)');
      ctx.fillStyle = bottom;
      ctx.fillRect(0, height - 160, width, 160);

      const padX = 68;
      const titleY = 168;
      ctx.font = '800 108px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillText('OPTIMUS', padX + 3, titleY + 90);
      ctx.fillStyle = '#f5f8fc';
      ctx.fillText('OPTIMUS', padX, titleY + 86);

      const titleWidth = ctx.measureText('OPTIMUS').width;
      const ulineY = titleY + 118;
      ctx.shadowColor = 'rgba(55, 201, 255, 0.75)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#37c9ff';
      ctx.fillRect(padX, ulineY, titleWidth, 5);
      ctx.shadowBlur = 0;

      ctx.font = '700 30px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = '#b7f0ff';
      ctx.fillText('ESCAPE THE ASSEMBLY', padX, ulineY + 48);

      ctx.font = '500 24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = '#c4cdda';
      ctx.fillText('A humanoid factory robot climbs out of a decaying plant.', padX, ulineY + 96);

      ctx.font = '400 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = '#7c879b';
      ctx.fillText('FREE BROWSER GAME', padX, height - 46);
      ctx.fillStyle = '#4ad6ff';
      ctx.fillRect(padX + 208, height - 58, 8, 8);
      ctx.fillStyle = '#7c879b';
      ctx.fillText('SIDE-SCROLLER', padX + 226, height - 46);

      const out = canvas.toDataURL('image/png');
      return out.slice('data:image/png;base64,'.length);
    },
    { sourceDataUrl, width: W, height: H },
  );

  writeFileSync(OUT, Buffer.from(png, 'base64'));
  console.log(`[og] wrote ${OUT}`);
  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * Live progress page generator.
 *
 * Produces a self-contained `progress/index.html` that can be opened directly
 * or served, showing the latest captured stills, clips, objective metrics, and
 * round notes. It auto-refreshes so the build can be watched without
 * interrupting it.
 *
 * The page is regenerated and committed at the end of every round, so the
 * repository itself carries the visual history of the project rather than that
 * history living only in a chat log.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const PROGRESS_DIR = join(ROOT, 'progress');
const MEDIA_DIR = join(PROGRESS_DIR, 'media');
const ROUNDS_FILE = join(PROGRESS_DIR, 'rounds.json');

export interface RoundScores {
  animationFluidity?: number;
  frameConsistency?: number;
  scaleCoherence?: number;
  atmosphere?: number;
  lighting?: number;
  particles?: number;
  presence?: number;
  composition?: number;
  thematicCoherence?: number;
  combatImpact?: number;
  audio?: number;
  uiPolish?: number;
}

export interface Round {
  round: number;
  date: string;
  title: string;
  /** What was built this round. */
  notes: string[];
  /** The single biggest gap identified, which becomes the next round's focus. */
  biggestGap: string;
  scores: RoundScores;
  /** Commit revision the captures came from. */
  revision?: string;
}

const SCORE_LABELS: Record<keyof RoundScores, string> = {
  animationFluidity: 'Animation fluidity',
  frameConsistency: 'Frame consistency',
  scaleCoherence: 'Scale coherence',
  atmosphere: 'Atmospheric relevance',
  lighting: 'Lighting',
  particles: 'Particle quality',
  presence: 'Presence',
  composition: 'Composition & readability',
  thematicCoherence: 'Thematic coherence',
  combatImpact: 'Combat impact',
  audio: 'Audio',
  uiPolish: 'UI polish',
};

interface MediaItem {
  path: string;
  name: string;
  kind: 'image' | 'video';
  group: string;
  modified: number;
  sizeKB: number;
}

function collectMedia(dir: string, group: string, out: MediaItem[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collectMedia(full, entry, out);
      continue;
    }
    const ext = extname(entry).toLowerCase();
    const kind = ext === '.mp4' || ext === '.webm' ? 'video' : ext === '.png' || ext === '.jpg' ? 'image' : null;
    if (!kind) continue;
    out.push({
      // Relative to progress/index.html, which is where the page lives.
      path: full.slice(PROGRESS_DIR.length + 1).split('\\').join('/'),
      name: basename(entry, ext),
      kind,
      group,
      modified: stats.mtimeMs,
      sizeKB: Math.round(stats.size / 1024),
    });
  }
}

interface MetricsFile {
  scenario: string;
  image: Record<string, unknown>;
  stats: Record<string, number>;
}

function collectMetrics(): MetricsFile[] {
  if (!existsSync(MEDIA_DIR)) return [];
  const out: MetricsFile[] = [];
  for (const entry of readdirSync(MEDIA_DIR)) {
    if (!entry.endsWith('.metrics.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(MEDIA_DIR, entry), 'utf8')) as MetricsFile);
    } catch {
      // A malformed metrics file should not take the whole page down.
    }
  }
  return out;
}

function loadRounds(): Round[] {
  if (!existsSync(ROUNDS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(ROUNDS_FILE, 'utf8')) as Round[];
  } catch {
    return [];
  }
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Renders a score as a bar, coloured by band. */
function scoreBar(label: string, value: number | undefined): string {
  if (value === undefined) {
    return `<div class="score"><span class="label">${escapeHtml(label)}</span>
      <span class="track"><i style="width:0%"></i></span><span class="val">—</span></div>`;
  }
  const percent = Math.max(0, Math.min(100, value * 10));
  const band = value >= 8 ? 'good' : value >= 6 ? 'ok' : 'poor';
  return `<div class="score"><span class="label">${escapeHtml(label)}</span>
    <span class="track ${band}"><i style="width:${percent}%"></i></span>
    <span class="val">${value.toFixed(1)}</span></div>`;
}

function metricRow(label: string, value: unknown, target?: string): string {
  const text =
    typeof value === 'number'
      ? Math.abs(value) < 0.01 && value !== 0
        ? value.toExponential(2)
        : value.toFixed(3)
      : String(value);
  return `<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(text)}</td>
    <td class="target">${escapeHtml(target ?? '')}</td></tr>`;
}

function buildHtml(rounds: Round[], media: MediaItem[], metrics: MetricsFile[]): string {
  const latest = rounds[rounds.length - 1];
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 19);

  media.sort((a, b) => b.modified - a.modified);
  const videos = media.filter((m) => m.kind === 'video');
  const groups = new Map<string, MediaItem[]>();
  for (const item of media.filter((m) => m.kind === 'image')) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }

  const roundHistory = rounds
    .slice()
    .reverse()
    .map(
      (round) => `
      <article class="round">
        <header>
          <h3>Round ${round.round} — ${escapeHtml(round.title)}</h3>
          <time>${escapeHtml(round.date)}${round.revision ? ` · ${escapeHtml(round.revision)}` : ''}</time>
        </header>
        <ul>${round.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
        <p class="gap"><strong>Biggest remaining gap:</strong> ${escapeHtml(round.biggestGap)}</p>
      </article>`,
    )
    .join('');

  const scoreBlock = latest
    ? (Object.keys(SCORE_LABELS) as (keyof RoundScores)[])
        .map((key) => scoreBar(SCORE_LABELS[key], latest.scores[key]))
        .join('')
    : '<p class="muted">No scored round yet.</p>';

  const metricsBlock = metrics
    .map((file) => {
      const image = file.image as Record<string, number>;
      const bandContrast = (image.bandContrast as unknown as number[]) ?? [0, 0, 0];
      const bandSaturation = (image.bandSaturation as unknown as number[]) ?? [0, 0, 0];
      const depthRatio =
        bandContrast[0]! > 0 ? (bandContrast[2]! / bandContrast[0]!).toFixed(2) : 'n/a';
      const satRatio =
        bandSaturation[2]! > 0 ? (bandSaturation[0]! / bandSaturation[2]!).toFixed(2) : 'n/a';
      return `
      <div class="metrics-card">
        <h4>${escapeHtml(file.scenario)}</h4>
        <table>
          <thead><tr><th>metric</th><th class="num">value</th><th class="target">target</th></tr></thead>
          <tbody>
            ${metricRow('dynamic range (p99-p1)', image.dynamicRange, '&ge; 0.72')}
            ${metricRow('mean luminance', image.meanLuminance, '0.18 - 0.45')}
            ${metricRow('clipped white', image.clippedWhite, '&lt; 0.005')}
            ${metricRow('clipped black', image.clippedBlack, '&lt; 0.05')}
            ${metricRow('near/far contrast ratio', depthRatio, '1.8 - 3.5')}
            ${metricRow('far/near saturation', satRatio, '0.35 - 0.70')}
            ${metricRow('bloom energy', image.bloomEnergy, '0.015 - 0.06')}
            ${metricRow('local contrast', image.localContrast, '&ge; 0.03')}
            ${metricRow('cyan accent presence', image.cyanPresence, '0.002 - 0.05')}
            ${metricRow('hue entropy', image.hueEntropy, '&le; 0.75')}
            ${metricRow('draw calls', file.stats?.drawCalls, '&le; 120')}
            ${metricRow('fullscreen passes', file.stats?.fullscreenPasses, '&le; 18')}
          </tbody>
        </table>
      </div>`;
    })
    .join('');

  const galleryBlock = [...groups.entries()]
    .map(
      ([group, items]) => `
      <section class="gallery-group">
        <h3>${escapeHtml(group === 'media' ? 'scenes' : group)}</h3>
        <div class="grid">
          ${items
            .map(
              (item) => `<figure>
                <a href="${escapeHtml(item.path)}" target="_blank" rel="noopener">
                  <img src="${escapeHtml(item.path)}" alt="${escapeHtml(item.name)}" loading="lazy" />
                </a>
                <figcaption>${escapeHtml(item.name)} <span>${item.sizeKB} KB</span></figcaption>
              </figure>`,
            )
            .join('')}
        </div>
      </section>`,
    )
    .join('');

  const videoBlock = videos.length
    ? videos
        .map(
          (item) => `<figure class="video">
            <video src="${escapeHtml(item.path)}" controls loop muted playsinline preload="metadata"></video>
            <figcaption>${escapeHtml(item.name)} <span>${item.sizeKB} KB · 60 fps</span></figcaption>
          </figure>`,
        )
        .join('')
    : '<p class="muted">No clips recorded yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!-- Auto-refresh so the build can be watched without interrupting it. -->
<meta http-equiv="refresh" content="30" />
<title>OPTIMUS: RED PROTOCOL — build progress</title>
<style>
  :root {
    --bg: #0a0c10; --panel: #12161d; --line: #1e242e;
    --text: #dfe6ef; --muted: #7d8899; --cyan: #3fe9ff; --amber: #ffa63f; --red: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header.top {
    padding: 28px 32px 20px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #12161d, #0a0c10);
  }
  h1 { margin: 0; font-size: 22px; font-weight: 300; letter-spacing: 0.32em; text-transform: uppercase; }
  h1 b { color: var(--cyan); font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; letter-spacing: 0.14em; margin-top: 8px; text-transform: uppercase; }
  main { padding: 24px 32px 80px; max-width: 1600px; margin: 0 auto; }
  section { margin-bottom: 44px; }
  h2 {
    font-size: 12px; letter-spacing: 0.28em; text-transform: uppercase;
    color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line);
    padding-bottom: 10px; margin: 0 0 18px;
  }
  h3 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  figure img, figure video { width: 100%; display: block; background: #000; }
  figcaption {
    padding: 8px 10px; font-size: 11px; color: var(--muted);
    display: flex; justify-content: space-between; gap: 8px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .gallery-group { margin-bottom: 28px; }
  .video { max-width: 720px; }
  .videos { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
  .score { display: grid; grid-template-columns: 200px 1fr 40px; align-items: center; gap: 12px; margin-bottom: 7px; }
  .score .label { font-size: 12px; color: var(--muted); }
  .score .track { height: 6px; background: #1a1f28; border-radius: 3px; overflow: hidden; }
  .score .track i { display: block; height: 100%; background: var(--cyan); }
  .score .track.good i { background: var(--cyan); }
  .score .track.ok i { background: var(--amber); }
  .score .track.poor i { background: var(--red); }
  .score .val { font-size: 12px; text-align: right; font-family: ui-monospace, monospace; }
  .round { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 16px 18px; margin-bottom: 14px; }
  .round header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  .round h3 { margin: 0; }
  .round time { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .round ul { margin: 10px 0; padding-left: 18px; }
  .round li { margin-bottom: 4px; }
  .gap { margin: 12px 0 0; padding: 10px 12px; background: #171b23; border-left: 2px solid var(--amber); border-radius: 0 4px 4px 0; font-size: 13px; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
  .metrics-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }
  .metrics-card h4 { margin: 0 0 10px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  td { padding: 3px 0; border-bottom: 1px solid #161a21; }
  td.num, th.num { text-align: right; }
  td.target, th.target { text-align: right; color: var(--muted); padding-left: 12px; }
  .muted { color: var(--muted); }
  a { color: var(--cyan); }
  .banner { background: var(--panel); border: 1px solid var(--line); border-left: 2px solid var(--cyan); border-radius: 0 6px 6px 0; padding: 14px 18px; margin-bottom: 24px; }
  .banner strong { color: var(--cyan); }
</style>
</head>
<body>
<header class="top">
  <h1>Optimus<b>:</b> Red Protocol</h1>
  <div class="sub">build progress &middot; generated ${escapeHtml(generated)} UTC &middot; page refreshes every 30 s</div>
</header>
<main>
  ${
    latest
      ? `<div class="banner"><strong>Round ${latest.round}: ${escapeHtml(latest.title)}</strong><br />
         Currently working on: ${escapeHtml(latest.biggestGap)}</div>`
      : ''
  }

  <section>
    <h2>Latest clips (recorded at a locked 60 fps)</h2>
    <div class="videos">${videoBlock}</div>
  </section>

  <section>
    <h2>Stills</h2>
    ${galleryBlock || '<p class="muted">No stills captured yet.</p>'}
  </section>

  <section>
    <h2>Blind critique scores</h2>
    ${scoreBlock}
  </section>

  <section>
    <h2>Objective metrics</h2>
    <div class="metrics">${metricsBlock || '<p class="muted">No metrics recorded yet.</p>'}</div>
  </section>

  <section>
    <h2>Round history</h2>
    ${roundHistory || '<p class="muted">No rounds recorded yet.</p>'}
  </section>
</main>
</body>
</html>
`;
}

function main(): void {
  mkdirSync(PROGRESS_DIR, { recursive: true });

  const rounds = loadRounds();
  const media: MediaItem[] = [];
  collectMedia(MEDIA_DIR, 'media', media);
  const metrics = collectMetrics();

  const html = buildHtml(rounds, media, metrics);
  writeFileSync(join(PROGRESS_DIR, 'index.html'), html);

  console.log(
    `progress page written: ${media.length} media files, ` +
      `${metrics.length} metrics files, ${rounds.length} rounds`,
  );
}

main();

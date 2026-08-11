#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const repository = process.env.GITHUB_REPOSITORY || 'EvanZhang008/open-walnut';
const token = process.env.GITHUB_TOKEN?.trim();
const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const outputPath = process.env.STAR_HISTORY_OUTPUT
  || path.resolve('docs/assets/star-history.svg');

if (!/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
}

const headers = {
  Accept: 'application/vnd.github.star+json',
  'User-Agent': 'open-walnut-star-history',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function fetchJson(apiPath) {
  const response = await fetch(`${apiBase}${apiPath}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchRepository() {
  return fetchJson(`/repos/${repository}`);
}

async function fetchStargazers() {
  const stargazers = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(
      `/repos/${repository}/stargazers?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) {
      throw new Error('GitHub returned an invalid stargazers response');
    }
    stargazers.push(...batch);
    if (batch.length < 100) return stargazers;
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function niceMaximum(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatDate(timestamp, durationDays) {
  const options = durationDays < 180
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { month: 'short', year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', options).format(new Date(timestamp));
}

function renderChart(metadata, stargazers) {
  const width = 900;
  const height = 460;
  const margin = { top: 86, right: 42, bottom: 64, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseline = margin.top + plotHeight;

  const starTimes = stargazers
    .map((entry) => Date.parse(entry.starred_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (starTimes.length !== stargazers.length) {
    throw new Error(
      `Expected ${stargazers.length} timestamped stars, received ${starTimes.length}`,
    );
  }

  const createdAt = Date.parse(metadata.created_at);
  const start = starTimes[0] ?? createdAt;
  const today = new Date();
  const endOfTodayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
  ) - 1;
  const end = Math.max(endOfTodayUtc, start + 86_400_000);
  const duration = end - start;
  const durationDays = duration / 86_400_000;
  const yMax = niceMaximum(starTimes.length);

  const x = (timestamp) => margin.left + ((timestamp - start) / duration) * plotWidth;
  const y = (count) => margin.top + plotHeight - (count / yMax) * plotHeight;
  const number = (value) => Number(value.toFixed(2));

  const lineParts = [`M ${number(x(start))} ${number(y(0))}`];
  starTimes.forEach((timestamp, index) => {
    lineParts.push(`H ${number(x(timestamp))} V ${number(y(index + 1))}`);
  });
  lineParts.push(`H ${number(x(end))}`);
  const linePath = lineParts.join(' ');
  const areaPath = `${linePath} V ${baseline} H ${margin.left} Z`;

  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (yMax / 5) * index;
    const yPos = y(value);
    return `  <line class="grid" x1="${margin.left}" y1="${number(yPos)}" x2="${width - margin.right}" y2="${number(yPos)}" />
  <text class="axis-label" x="${margin.left - 14}" y="${number(yPos + 4)}" text-anchor="end">${value}</text>`;
  }).join('\n');

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = start + (duration * index) / 4;
    const xPos = x(timestamp);
    return `  <line class="tick" x1="${number(xPos)}" y1="${baseline}" x2="${number(xPos)}" y2="${baseline + 6}" />
  <text class="axis-label" x="${number(xPos)}" y="${baseline + 28}" text-anchor="middle">${escapeXml(formatDate(timestamp, durationDays))}</text>`;
  }).join('\n');

  const title = `${repository} star history`;
  const description = `${starTimes.length} cumulative GitHub stars since ${formatDate(start, durationDays)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(title)}</title>
  <desc id="description">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f81f7" stop-opacity="0.32" />
      <stop offset="100%" stop-color="#2f81f7" stop-opacity="0.04" />
    </linearGradient>
    <style>
      .background { fill: #ffffff; }
      .border { fill: none; stroke: #d0d7de; }
      .grid { stroke: #d8dee4; stroke-width: 1; }
      .tick { stroke: #8c959f; stroke-width: 1; }
      .axis-label { fill: #57606a; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .chart-title { fill: #1f2328; font: 600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .chart-total { fill: #1f2328; font: 700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .chart-caption { fill: #57606a; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .line { fill: none; stroke: #0969da; stroke-linejoin: round; stroke-width: 3; }
      @media (prefers-color-scheme: dark) {
        .background { fill: #0d1117; }
        .border { stroke: #30363d; }
        .grid { stroke: #30363d; }
        .tick { stroke: #6e7681; }
        .axis-label, .chart-caption { fill: #8c959f; }
        .chart-title, .chart-total { fill: #f0f6fc; }
        .line { stroke: #58a6ff; }
      }
    </style>
  </defs>
  <rect class="background" width="${width}" height="${height}" rx="8" />
  <rect class="border" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" />
  <text class="chart-title" x="${margin.left}" y="42">${escapeXml(repository)}</text>
  <text class="chart-caption" x="${margin.left}" y="64">GitHub star history</text>
  <text class="chart-total" x="${width - margin.right}" y="44" text-anchor="end">${starTimes.length}</text>
  <text class="chart-caption" x="${width - margin.right}" y="64" text-anchor="end">stars</text>
${yTicks}
${xTicks}
  <path d="${areaPath}" fill="url(#area)" />
  <path class="line" d="${linePath}" />
  <text class="chart-caption" x="${width - margin.right}" y="${height - 18}" text-anchor="end">Updated from the GitHub API</text>
</svg>
`;
}

const metadata = await fetchRepository();
const stargazers = await fetchStargazers();
const svg = renderChart(metadata, stargazers);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, svg, 'utf8');
console.log(`Wrote ${outputPath} with ${stargazers.length} stars`);

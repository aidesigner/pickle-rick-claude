// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDeathCrystalReport } from '../services/death-crystal-html.js';

// Pins the AC-DC-1F structural + security invariants of the death-crystal HTML
// renderer (R-DC-1D). A synthetic report with >=3 candidates + a top
// recommendation is rendered, then the emitted HTML is asserted to keep its
// card count, single Top Recommendation section, and CDN-only <script> surface.

function makeCandidate(id, strength) {
  return {
    id,
    files: [`extension/src/services/${id}.ts`],
    problem: `${id} hides no complexity behind its interface.`,
    solution: `Collapse ${id} into its single caller.`,
    benefits: [`Removes a pass-through Module`, `Concentrates ${id} logic at one Seam`],
    beforeAfterDiagram: `graph LR; A[caller] --> B[${id}]`,
    strength,
  };
}

function makeReport() {
  return {
    generatedAt: '2026-05-29T12:00:00.000Z',
    candidates: [
      makeCandidate('alpha-module', 'strong'),
      makeCandidate('beta-module', 'moderate'),
      makeCandidate('gamma-module', 'speculative'),
    ],
    topRecommendation: {
      candidateId: 'alpha-module',
      rationale: 'Deepest Seam — highest leverage per unit of interface learned.',
    },
  };
}

test('renders >=3 article cards', () => {
  const html = renderDeathCrystalReport(makeReport());
  const articles = html.match(/<article/g) || [];
  assert.ok(articles.length >= 3, `expected >=3 <article> cards, got ${articles.length}`);
});

test('renders exactly one top-recommendation section', () => {
  const html = renderDeathCrystalReport(makeReport());
  const sections = html.match(/<section id="top-recommendation"/g) || [];
  assert.equal(sections.length, 1);
});

test('embeds the Tailwind CDN script tag', () => {
  const html = renderDeathCrystalReport(makeReport());
  assert.ok(html.includes('<script src="https://cdn.tailwindcss.com"'));
});

test('embeds the Mermaid CDN ESM import (mermaid@11)', () => {
  const html = renderDeathCrystalReport(makeReport());
  assert.ok(html.includes('<script type="module">'), 'expected a Mermaid ESM module script');
  assert.ok(html.includes('mermaid@11'), 'expected the mermaid@11 CDN import');
});

test('SECURITY: emits no <script> outside the two allowed CDN tags', () => {
  const html = renderDeathCrystalReport(makeReport());
  const scripts = html.match(/<script/g) || [];
  // Exactly two: the Tailwind <script src> and the Mermaid <script type="module"> ESM import.
  assert.equal(scripts.length, 2, `expected exactly 2 <script tags (Tailwind + Mermaid), got ${scripts.length}`);
});

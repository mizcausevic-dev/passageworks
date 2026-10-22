import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, sanitizeRichHtml, stripSharedCitations } from "../src/sanitize.ts";

test("extracted html drops scripts and javascript urls", () => {
  const clean = sanitizeRichHtml(`
    <script>alert(1)</script>
    <img src=x onerror="alert(1)">
    <h1>Northglass Basin Circular</h1>
    <p>Visitors must stay clear of the veldtide gauge during dye releases.</p>
    <a href="javascript:alert(1)">bad</a>
    <a href="https://archive.northglass.example/circular">circular</a>
  `);
  assert.equal(clean.includes("<script"), false);
  assert.equal(clean.includes("onerror"), false);
  assert.equal(clean.includes("javascript:"), false);
  assert.match(clean, /veldtide gauge/);
  assert.match(clean, /href="https:\/\/archive.northglass.example\/circular"/);
  assert.match(htmlToText(clean), /Visitors must stay clear/);
});

test("share rendering can remove passage identifiers", () => {
  const html = sanitizeRichHtml(`<p>See [[psg_0123456789abcdef]]</p>`);
  assert.match(html, /data-passage-id="psg_0123456789abcdef"/);
  const hidden = stripSharedCitations(html);
  assert.equal(hidden.includes("psg_"), false);
});

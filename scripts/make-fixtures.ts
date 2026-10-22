import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/northglass");
await mkdir(root, { recursive: true });

const methods = await PDFDocument.create();
const page = methods.addPage([612, 792]);
const font = await methods.embedFont(StandardFonts.TimesRoman);
page.drawText("A note on the dye-trace method at Northglass Basin.", {
  x: 72,
  y: 720,
  size: 16,
  font,
  color: rgb(0.1, 0.08, 0.05),
});
page.drawText("The carmine dye lot ND-12 was released above the veldtide gauge.", {
  x: 72,
  y: 680,
  size: 12,
  font,
  color: rgb(0.1, 0.08, 0.05),
});
page.drawText("This page is fictional and exists so extraction can be inspected.", {
  x: 72,
  y: 652,
  size: 12,
  font,
  color: rgb(0.1, 0.08, 0.05),
});
await writeFile(join(root, "methods-note.pdf"), await methods.save());

const scan = await PDFDocument.create();
const scanPage = scan.addPage([320, 320]);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const image = await scan.embedPng(png);
scanPage.drawImage(image, { x: 48, y: 48, width: 120, height: 120 });
await writeFile(join(root, "plate-7.pdf"), await scan.save());

const html = `<!doctype html>
<html><head><title>Northglass Circular</title></head>
<body>
<script>alert("xss")</script>
<h1>Northglass Basin Circular</h1>
<p>Visitors must stay clear of the veldtide gauge during dye releases.</p>
<a href="javascript:alert(1)">bad</a>
<a href="https://archive.northglass.example/circular">circular</a>
</body></html>
`;
await writeFile(join(root, "circular.html"), html);
console.log(JSON.stringify({ event: "fixtures_written", root }));

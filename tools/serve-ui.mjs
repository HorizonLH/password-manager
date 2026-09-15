/**
 * Static server for `ui/`, used by the UI audit. It injects the fixture IPC
 * bridge (tools/ui-fixtures.js) before the application scripts so the views can
 * be rendered and measured in a plain browser.
 *
 *   node tools/serve-ui.mjs           # http://127.0.0.1:5173
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.join(here, "..", "ui");
const fixtures = path.join(here, "ui-fixtures.js");
const port = Number(process.env.SAPVAULT_UI_PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/__fixtures.js") {
    response.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
    response.end(fs.readFileSync(fixtures));
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(uiRoot, relative);
  if (!file.startsWith(uiRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end("not found");
    return;
  }

  let body = fs.readFileSync(file);
  if (relative === "index.html") {
    body = Buffer.from(
      String(body).replace(
        '<script type="module" src="js/app.js"></script>',
        '<script src="/__fixtures.js"></script>\n    <script type="module" src="js/app.js"></script>',
      ),
    );
  }

  response.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ui served at http://127.0.0.1:${port} (fixtures injected)`);
});

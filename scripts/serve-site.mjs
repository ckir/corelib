import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const SITE_DIR = join(ROOT, "_site");

const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".woff2": "font/woff2",
};

function getContentType(filePath) {
	const ext = extname(filePath).toLowerCase();
	return MIME_TYPES[ext] || "application/octet-stream";
}

function serve() {
	const port = process.env.PORT ?? 4173;
	const host = "127.0.0.1";

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url, `http://${host}:${port}`);
			let pathname = decodeURIComponent(url.pathname);

			// Reject path traversal
			if (pathname.includes("..")) {
				const notFoundPath = join(SITE_DIR, "404.html");
				if (existsSync(notFoundPath)) {
					const content = readFileSync(notFoundPath);
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(content);
				} else {
					res.writeHead(404);
					res.end();
				}
				process.stdout.write(`${req.method} ${pathname} 404\n`);
				return;
			}

			// Normalize path
			const normalizedPath = normalize(pathname).replace(/\\/g, "/");
			if (normalizedPath.includes("..")) {
				const notFoundPath = join(SITE_DIR, "404.html");
				if (existsSync(notFoundPath)) {
					const content = readFileSync(notFoundPath);
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(content);
				} else {
					res.writeHead(404);
					res.end();
				}
				process.stdout.write(`${req.method} ${pathname} 404\n`);
				return;
			}

			let filePath = join(SITE_DIR, normalizedPath.startsWith("/") ? normalizedPath.slice(1) : normalizedPath);

			// Prevent escaping site dir
			const resolvedSite = resolve(SITE_DIR);
			const resolvedFile = resolve(filePath);
			if (!resolvedFile.startsWith(resolvedSite)) {
				const notFoundPath = join(SITE_DIR, "404.html");
				if (existsSync(notFoundPath)) {
					const content = readFileSync(notFoundPath);
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(content);
				} else {
					res.writeHead(404);
					res.end();
				}
				process.stdout.write(`${req.method} ${pathname} 404\n`);
				return;
			}

			// Check if it's a directory or needs index.html
			if (existsSync(filePath)) {
				const stats = statSync(filePath);
				if (stats.isDirectory()) {
					filePath = join(filePath, "index.html");
				}
			} else if (pathname === "/" || pathname === "") {
				filePath = join(SITE_DIR, "index.html");
			}

			// If file doesn't exist, serve 404
			if (!existsSync(filePath)) {
				const notFoundPath = join(SITE_DIR, "404.html");
				if (existsSync(notFoundPath)) {
					const content = readFileSync(notFoundPath);
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(content);
					process.stdout.write(`${req.method} ${pathname} 404\n`);
					return;
				} else {
					res.writeHead(404);
					res.end();
					process.stdout.write(`${req.method} ${pathname} 404\n`);
					return;
				}
			}

			const content = readFileSync(filePath);
			const contentType = getContentType(filePath);
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
			process.stdout.write(`${req.method} ${pathname} 200\n`);
		} catch (err) {
			res.writeHead(500);
			res.end();
			process.stdout.write(`${req.method} ${req.url} 500\n`);
		}
	});

	server.listen(port, host, () => {
		process.stdout.write(`site: serving _site at http://${host}:${port}\n`);
	});
}

serve();

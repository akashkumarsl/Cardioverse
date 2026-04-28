from __future__ import annotations
import sys
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5600

FORCED_MIME = {
    ".js":   "text/javascript",
    ".mjs":  "text/javascript",
    ".json": "application/json",
    ".css":  "text/css",
    ".html": "text/html",
    ".svg":  "image/svg+xml",
}

class Handler(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = Path(path).suffix.lower()
        if ext in FORCED_MIME:
            return FORCED_MIME[ext]
        return super().guess_type(path)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"Serving http://localhost:{PORT}")
        httpd.serve_forever()
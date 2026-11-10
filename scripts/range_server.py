#!/usr/bin/env python3
"""Tiny HTTP server with HTTP Range support for testing yt-dlp section downloads."""
import os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FILE = sys.argv[1]
PORT = int(sys.argv[2])

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        size = os.path.getsize(FILE)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = int(m.group(2))
                status = 206
        end = min(end, size - 1)
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(FILE, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
    def do_HEAD(self):
        size = os.path.getsize(FILE)
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
    def log_message(self, *a):
        pass

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

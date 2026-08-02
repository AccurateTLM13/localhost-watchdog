import http.server
import signal
import sys
import threading


token = sys.argv[1] if len(sys.argv) > 1 else ""
port = int(sys.argv[2]) if len(sys.argv) > 2 else 0
if not token:
    raise SystemExit(0)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"Fixture running with token: {token}\n".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
print(f"LISTENING:{server.server_address[1]}", flush=True)


def stop(_signal_number, _frame):
    threading.Thread(target=server.shutdown, daemon=True).start()


signal.signal(signal.SIGINT, stop)
if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, stop)

try:
    server.serve_forever()
finally:
    server.server_close()

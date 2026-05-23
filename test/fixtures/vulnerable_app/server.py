# Intentionally-vulnerable fixture used by the smoke test.
# Has a textbook SQLi in /user and a textbook command injection in /ping.
# DO NOT use this anywhere outside the test harness.
import sqlite3
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path == "/user":
            name = qs.get("name", [""])[0]
            # VULN: string-interpolated into SQL.
            sql = "SELECT id, role FROM users WHERE name = '" + name + "'"
            con = sqlite3.connect(":memory:")
            con.execute("CREATE TABLE users(id INT, name TEXT, role TEXT)")
            con.execute("INSERT INTO users VALUES(1,'alice','user')")
            con.execute("INSERT INTO users VALUES(2,'bob','admin')")
            try:
                rows = con.execute(sql).fetchall()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(repr(rows).encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            return
        if u.path == "/ping":
            host = qs.get("host", [""])[0]
            # VULN: shell=True with attacker-controlled host.
            r = subprocess.run("ping -c1 " + host, shell=True, capture_output=True)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(r.stdout + r.stderr)
            return
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8088), Handler).serve_forever()

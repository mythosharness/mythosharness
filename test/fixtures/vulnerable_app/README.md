# Vulnerable fixture

Two textbook vulnerabilities for the smoke test to find:

- `/user?name=<input>` — SQL injection (string-interpolated into a SQL query)
- `/ping?host=<input>` — Command injection (`subprocess.run(..., shell=True)`)

Run: `python3 server.py` then `curl 'http://127.0.0.1:8088/user?name=alice%27%20OR%201=1--'`.

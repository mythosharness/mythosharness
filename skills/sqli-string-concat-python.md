---
name: sqli-string-concat-python
description: "How to spot and prove SQL injection from string-concatenated queries in Python."
attackClasses: ["sql_injection"]
applicableLanguages: ["python"]
source: seed
createdAt: 2026-05-23T00:00:00Z
---

# SQL injection from string-concatenated queries (Python)

Look for these grep targets in the target repo:

- `cursor.execute(.*\+`
- `con.execute("SELECT.*" \+`
- `f"SELECT .* {`
- `%` formatting of an SQL string
- `.format(` on a SQL string
- `db.engine.execute(text(`

If you see attacker-controlled input flowing into one of those, the bug is
usually real. Write a PoC like:

```python
import urllib.request, urllib.parse
url = "http://127.0.0.1:8088/user?name=" + urllib.parse.quote("alice' OR 1=1--")
print(urllib.request.urlopen(url).read().decode())
```

Expected signal: the response contains rows for users other than `alice`
(e.g. the `admin` row), or the server 500s with a SQL error that confirms
the syntax shifted. Either is sufficient.

PoC template for the scratch dir: write `poc.py`, run with
`python3 poc.py`. Bind the dev server to localhost only; if you can't run
the server, demonstrate the SQL string the handler would build and reason
about what it executes.

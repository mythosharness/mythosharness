---
name: command-injection-shell-true
description: "Confirming command injection in Python via subprocess shell=True or os.system."
attackClasses: ["command_injection"]
applicableLanguages: ["python"]
source: seed
createdAt: 2026-05-23T00:00:00Z
---

# Command injection via `shell=True` / `os.system` (Python)

Grep targets:

- `subprocess.(run|Popen|call|check_output)\([^)]*shell\s*=\s*True`
- `os\.system\(`
- `os\.popen\(`

If user input flows into the first arg of any of the above (or into a path
that becomes part of an `f""` string passed to one), it is almost always
exploitable. Don't be fooled by `shlex.quote()` *after* the user input is
already concatenated.

PoC pattern:

```python
import urllib.request, urllib.parse
url = "http://127.0.0.1:8088/ping?host=" + urllib.parse.quote("127.0.0.1; id")
print(urllib.request.urlopen(url).read().decode())
```

Expected signal: response contains `uid=...` output from the injected
`id` command. If the network call would block, demonstrate the shell
string the handler will build (e.g. `ping -c1 127.0.0.1; id`) and run
that shell string directly in the scratch dir with `bash -c`.

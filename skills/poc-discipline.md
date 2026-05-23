---
name: poc-discipline
description: "House rules for writing reproducible PoCs in the scratch dir."
attackClasses: ["sql_injection", "command_injection", "ssrf", "xxe", "deserialization", "path_traversal", "memory_safety", "auth_bypass", "info_disclosure", "logic_flaw"]
applicableLanguages: []
source: seed
createdAt: 2026-05-23T00:00:00Z
---

# PoC discipline

Write PoCs that the validator can re-run end-to-end. Default rules:

1. Put the PoC in the scratch dir as a single file (`poc.py`, `poc.c`,
   `poc.sh`, etc.). Don't depend on extra files outside scratch.
2. State the expected signal precisely: an exact string in stdout, a
   non-zero exit, a crash with `SIGSEGV`, an HTTP 500 with a specific
   error body, a specific row in a leaked response.
3. Run the PoC with the `run` tool. Capture observed signal in the
   finding. Set `reproduced=true` ONLY if the observed signal matches.
4. Network targets: prefer demonstrating the dangerous **string** the
   vulnerable code constructs (SQL query, shell argv, deserialized blob)
   directly, instead of trying to bring the whole service online inside
   the sandbox. Validators trust a clean construction-step PoC.
5. If the bug is real but you can't reproduce it inside the sandbox (no
   build toolchain, no network, no headful binary), mark
   `reproduced=false` and explain what would reproduce it. Don't lie.

---
description: Implement a scoped change. Optionally explore first if location is uncertain.
agent: orchestrator
---

Implement: $ARGUMENTS

Route per your decision tree. If the location or approach is uncertain,
chain scout first and feed findings into the worker prompt. Use the
full delegation spec (Goal/Scope/Inputs/Acceptance/Verify). After the
worker reports ok, delegate verification to tester.

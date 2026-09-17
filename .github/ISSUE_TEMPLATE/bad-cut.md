---
name: The cut is wrong
about: The pipeline ran, and the result is not what it should be
labels: quality
---

## What you expected, and what you got

<!-- Which moment should have been in, or out, or longer. -->

## The evidence

```bash
oea explain evt_XXXX          # what it believed, and why
oea plan --json > plan.json   # what it did
```

<!-- Paste the explain output. It says what the system believed and which rules
     fired, which is usually where the disagreement is. -->

## Setup

- skill and duration:
- perception: <!-- local / python / fixture -->
- judgement: <!-- rules / a model, and which -->
- `oea doctor` output:

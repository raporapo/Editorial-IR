## What this changes

<!-- And why it is the right change. -->

## How it was checked

- [ ] `pnpm verify` passes
- [ ] If this touches how events are understood, judged, selected or trimmed:
      ran the worked example and read the resulting cut

```
<!-- If the cut changed, paste a before and after. Numbers are more use than
     adjectives: clip count, mean duration, what got dropped. -->
```

## Boundaries

- [ ] No editing application is visible above `packages/adapters`
- [ ] Works with no model and no API key configured
- [ ] User knowledge is not overwritten by model output
- [ ] Output is still deterministic
- [ ] `schemas/` regenerated if a schema changed

<!-- If any box is deliberately unticked, say why. Some of them should be
     unticked sometimes, and the reason is the interesting part. -->

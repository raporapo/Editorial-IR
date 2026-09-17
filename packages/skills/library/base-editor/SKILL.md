# base-editor

The judgement every other skill starts from.

It encodes four opinions, and deliberately no more:

1. **Importance dominates the ranking.** Everything else adjusts it.
2. **Redundancy is the strongest negative.** The most common failure of an
   automatic cut is showing the same thing three times, so a duplicate is
   penalised harder than a technically mediocre shot.
3. **Technically unusable material is dropped, not ranked.** A shot that is out
   of focus does not belong in a ranking of what to keep.
4. **The person who shot the footage outranks the rules.** An event the user
   marked essential survives every rule in this file, including one that would
   drop it.

## Extending it

Most skills should `extend` this one and change only what makes them different:

```yaml
name: my-style
extends: [base-editor]
scoring:
  weights:
    emotional_intensity: 0.9 # overrides just this weight
rules:
  - when: { narrative_role: payoff }
    action: { avoid_aggressive_cutting: true }
```

Weights merge key by key, and rules are appended after the parent's, so a child
rule wins at equal priority. See `docs/skills.md` for the whole field list.

# clip-reel

A folder of clips somebody already chose and trimmed — on their phone, in the
camera, in another app — strung together in the order they were taken.

## What it changes

- **Every clip is whole or absent.** A clip the user trimmed was trimmed on
  purpose, and trimming it again cuts their first syllable: measured on the
  probe's folder of phone clips, two were re-trimmed so that the first word was
  clipped. Here a clip is kept exactly as it is, and the target decides how many
  of them fit rather than how much of each.
- **Nothing the user chose is thrown out for looking like something else.** With
  no transcript and no vision model every clip is described the same way, and
  the base skill's duplicate rule then drops all but a couple. That rule, the
  filler rule and the dead-air cap apply here only to material that is not a
  clip the user trimmed.
- **Clips keep their sound.** A wordless clip is not turned into silent b-roll.
- **In order.** One budget for the whole reel and no arc: with whole clips of a
  few seconds each, a three-part budget spends itself unevenly.

Clips up to fifteen seconds are kept whole — the longest a file can be and still
be read as a clip the user trimmed. A longer file in the same folder, or one the
project says is `raw`, is cut as usual.

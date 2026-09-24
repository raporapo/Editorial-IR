# talking-head

One person explaining something to camera.

## What it changes

- **What is said carries the piece.** Information density and sound quality
  dominate the ranking; picture quality barely registers, because a slightly
  soft shot of someone making a good point is still a good point.
- **Speech is never cut into.** A trim inside a sentence produces a cut that
  sounds like a mistake, and a piece that runs ten seconds long is a smaller
  problem than one that sounds broken.
- **Clips are long.** Up to twenty-five seconds by default, and forty for a
  dense passage. Chopping an explanation into three-second pieces is a style
  choice that fights the material.
- **Silence without a reason is dropped**, and at least seventy percent of the
  running time has to carry speech.
- **Pauses come out.** Inside a clip, any pause of 0.7 seconds or more is taken
  out as a jump cut, keeping 120 ms either side so a word's tail and the next
  breath survive. A pause is silence by the same measure the rest of the
  analysis uses — quiet for this recording and quiet in absolute terms — or a
  gap between two timed words; it never reaches into a word, and a gap over
  music is not a pause. The pieces of one take are hard cuts, and the cut is
  budgeted by what is left, so a three-minute target is three minutes of
  speech rather than three minutes of source with holes in it.

`tech-youtube` extends this and inherits the jump cuts. Set
`remove_silences: false` in a skill of your own to keep the pauses.

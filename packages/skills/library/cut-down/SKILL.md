# cut-down

A shorter version of a programme somebody has already edited: the three-minute
film cut to sixty seconds, the episode cut to its highlights.

## What it changes

- **It cuts where the edit already cut.** Every in and out point moves onto one
  of the programme's own shot boundaries when one is within a second, and never
  leaves less than 400 ms of the neighbouring shot at either edge — a flash of
  the next shot is what a cut three frames off an edit looks like. Measured on
  the probe's edited programme before this existed, three of four inner edges of
  a cut carried such a flash.
- **It keeps the sound, and the length.** The base rule that turns a wordless
  shot into b-roll mutes it and caps it at four seconds, which for camera
  footage is right and for a finished programme is the music bed going silent —
  and, since a programme cut to music is wordless nearly throughout, every
  moment capped at four seconds. Measured on the probe's edited programme, that
  cap alone brought a 30-second cut-down in at 14.5 s. Here the rule is off.
- **Each section opens on its card.** Chapters in an edited programme begin at
  its title cards and cuts to black, and the first moment of a chapter is the
  card and what it introduces; it is preferred, and given long enough to read.
- **A subtitle is allowed to finish.** A clip with burned-in subtitles runs at
  least three seconds, roughly one subtitle.
- **The order is the programme's.** Nothing is moved.

Use it on material classified `edited` (see `oea analyze`), or tell the project
that a file is edited with `background.materials` in `context.yaml`.

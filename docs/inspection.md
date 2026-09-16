# Looking closer

Video is not understood at one resolution. The representation is a hierarchy,
and which layer you are working at is a decision with a price attached.

```text
Project
  Asset          one recording
    Chapter      a stretch of the day
      Event      a thing that happened  ← almost everything happens here
        Shot     a stretch of camera
          Frame  a picture
```

## Why the event layer is the default

An hour of footage is roughly seventy events, twelve chapters, several hundred
shots and two hundred thousand frames. Only one of those numbers is small enough
to hold in mind, to print on a terminal, or to hand to a model.

It is also the layer at which editing decisions are actually made. "Keep the
arrival, cut the queueing" is a sentence about events. It is not a sentence about
frames, and a system that reasons about frames has to reconstruct events before
it can say anything useful anyway.

So an agent is given events and chapters, and everything below is opt-in.

## The staircase

Each step costs more than the one above, and you take it only when the step above
was not enough.

| Step                        | What it costs                                 | What it answers                   |
| --------------------------- | --------------------------------------------- | --------------------------------- |
| `list_events`               | nothing                                       | what happened, and in what order  |
| `inspect_event`             | nothing                                       | speech, on-screen text, judgement |
| `list_shots`                | nothing                                       | is this one take or five          |
| `list_frames`               | a directory read                              | is there anything to look at      |
| `look_at_event` / `--sheet` | an ffmpeg run, and an image on a hosted model | what is actually on screen        |

On the command line:

```bash
oea inspect evt_0014              # the shots it is made of
oea inspect evt_0014 --frames     # the frames behind those shots
oea inspect evt_0014 --sheet      # all of them as one image
```

This is a different question from `oea explain`, which answers "why was this kept
or cut" from the record of the decision. `inspect` answers "what is in there",
from the material.

## Events are not shots

The two do not line up, and that is the reason the shot layer is worth being able
to ask about at all.

An event is a stretch of _meaning_; a shot is a stretch of _camera_. "Arriving at
the park" can be four shots. One long handheld take can span three events. In the
worked example, a thirty-eight second event described as `train_window, city`
turns out to be four distinct nine-second shots — which is the answer to "why
does this event look like that", and it is not visible anywhere in the event
summary.

## Why a contact sheet rather than frames

A hosted vision model charges per image. Eight separate frames cost eight images;
the same eight laid out in a grid cost one, answer "what happens here" about as
well, and additionally show the order — which separate images do not.

The grid is written to the project's work directory, which is a derivative and
safe to delete.

## When there is nothing to look at

A project ingested without frame sampling has no frames, and so does one whose
work directory has been cleared. Both are normal.

Asking to look then returns an empty result with the reason, not an error and not
a list of paths that will fail to open later. An agent gets a sentence it can act
on ("decide from the description, the speech and the shots"); a person gets told
where frames come from. The worked example replays a recorded analysis and
genuinely has none, which makes this the common case rather than an edge one.

## Where inspection lives

`packages/agent` reads an in-memory document and nothing else, which is what
makes an agent testable without a project on disk. Shots and frames are on disk,
so they arrive through an injected `InspectionSource` rather than through a
filesystem call inside the toolkit.

The practical consequence: a hosted deployment serves the same two layers from
object storage without changing anything above them.

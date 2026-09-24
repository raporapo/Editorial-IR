# @editorial-ir/adapters

One EditPlan, every place a cut has to go.

- Editing applications: OpenTimelineIO, Premiere Pro (Final Cut Pro 7 XML),
  Final Cut Pro and DaVinci Resolve (FCPXML 1.10), any conform (CMX 3600 EDL)
  and AviUtl2.
- Beside them: SubRip and WebVTT captions, YouTube chapters, and a rendered
  preview mp4 (ffmpeg).

An adapter translates a plan and nothing else — it never plans and never judges. That is what makes a second editor an adapter rather than a rewrite, and why the agent is never allowed to speak to an NLE directly. Captions are worked out before an adapter is called, for the same reason.

Capability differences are negotiated and reported. A dissolve that quietly became a cut is a change to someone's edit, and they are entitled to the list.

Every writer lays the plan on the same frame grid (`layOnGrid`), so an EDL, an FCPXML, a caption file and the preview land on the same frames as the NLE files beside them.

See [docs/adapters.md](../../docs/adapters.md).

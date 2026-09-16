# Writing an adapter

An adapter translates an EditPlan into something an editing application can open.
It never plans and never judges.

That constraint is the reason a second editor costs an adapter instead of a
rewrite — and the reason the agent is not allowed to speak to an NLE directly.
The moment it can, "what this particular application finds convenient" starts
leaking back into how events are understood.

## The interface

```ts
export interface EditorAdapter {
  readonly capabilities: AdapterCapabilities;
  apply(request: ApplyRequest): Promise<ApplyResult>;
  readTimeline?(request: ApplyRequest): Promise<EditPlan | undefined>;
  available?(): Promise<boolean>;
}
```

`apply` is the only required method. `readTimeline` is for targets that can hand
a timeline back, which is what the review loop uses to see what a human changed.

## Declare what you can do

```ts
export const RESOLVE_CAPABILITIES = AdapterCapabilities.parse({
  id: 'resolve',
  name: 'DaVinci Resolve',
  mode: 'file', // or 'live'
  output_extensions: ['.drp'],
  basic_transition: true,
  transition_types: ['cross_dissolve', 'dip_to_black'],
  speed_change: true,
  max_video_tracks: 8,
  audio_tracks: 4,
  text: false,
  notes: ['Times are frames at the sequence rate.'],
});
```

Then let `negotiate()` adjust the plan before you write anything:

```ts
const { plan, downgrades } = negotiate(request.plan, this.capabilities);
```

It resets speeds you cannot change, turns unsupported transitions into cuts, and
moves clips off tracks you do not have — and returns the list. Report it. A
dissolve that quietly became a cut is a change to someone's edit, and they are
entitled to see it.

## File or live

Prefer a file.

The Premiere adapter writes Final Cut Pro 7 XML rather than driving Premiere
through a plugin, and that is a considered choice. Driving it live needs Premiere
running, a plugin installed and versions of both to match. A file needs none of
that, can be produced on a machine with no Adobe software at all, and can be
diffed, reviewed and tested — which a sequence of API calls cannot.

A live transport belongs _beside_ a file adapter, not instead of it: a second
adapter with `mode: 'live'`, sharing the same plan.

## What the three shipped adapters are for

**OpenTimelineIO** proves the architecture. It is a real interchange format with
real importers, so a plan written here opens in tools this project has never
heard of. It is also the only output that can be checked in full by a test, which
makes it the reference the others are read against.

**Premiere Pro** is the first target anyone asks for. FCP7 XML, frames at the
sequence rate, each source file declared once and referenced after that — fifty
clips of one recording should not import as fifty master clips.

**AviUtl2** exists to prove independence with an editor that shares nothing with
Premiere: different platform, different community, no interchange standard in
common. It writes a versioned JSON job as the supported output and a best-effort
ExEdit object file for existing workflows, and says which is which rather than
implying that a community convention is a specification.

## Details that will bite

**Frame rates.** `frame_rate_num` and `frame_rate_den` are an exact rational.
29.97 is 30000/1001, and rounding it to 30 desynchronises an hour-long timeline
by nearly four seconds. Use `msToFrames(ms, num, den)`.

**Escaping.** File names and event descriptions are user content and routinely
contain ampersands and Japanese punctuation. One unescaped `&` makes an XML file
unopenable.

**Paths.** `resolveAssetPath()` turns an asset id into an absolute path and
`toFileUrl()` into the `file://` URL every interchange format wants, Windows
paths included.

**Metadata.** Put what you carry in your own namespace. The OTIO adapter uses
`metadata['editorial-ir']`, so no other tool mistakes it for its own.

## Registering it

Add it to `createAdapter()` and `listAdapters()` in
[`packages/adapters/src/registry.ts`](../packages/adapters/src/registry.ts).
`oea editors` picks it up, and so does `oea apply --editor <id>`.

## Testing it

Export a pure builder — `buildOtioTimeline`, `buildFcpXml`, `buildAviUtlJob` —
so the document can be checked without touching the filesystem, and test
`apply()` separately for the parts that are about files.

The worked example gives you a real plan with no ffmpeg, no GPU and no network:

```ts
const store = await makeExampleProject();
const { ir, observations } = await compileProject({
  store,
  suite: exampleSuite(),
  decision: new HeuristicDecisionBackend(),
});
const plan = planEdit({
  ir,
  skill: registry.resolve('travel-vlog'),
  targetDurationMs: 180_000,
  observations,
});
```

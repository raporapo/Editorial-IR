import { z } from 'zod';
import { Milliseconds, obj } from './primitives.js';
import { TransitionType } from './plan.js';

/**
 * What an editing application can actually do.
 *
 * Editors differ, and the honest way to handle that is to declare the
 * differences and let the planner work inside them, rather than to generate an
 * ambitious plan and discover in the NLE that half of it was ignored.
 */
export const AdapterCapabilities = obj({
  /** Stable adapter id, e.g. `otio`, `premiere`, `aviutl2`. */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * `file` writes a project or interchange file. `live` drives a running
   * application. A `file` adapter that only writes text is always available; one
   * that runs a program to make its file (the preview needs ffmpeg) says whether
   * it can through `available()`, like a `live` one.
   */
  mode: z.enum(['file', 'live']),
  /** Extensions this adapter can write, e.g. `['.otio']`. */
  output_extensions: z.array(z.string()).default([]),

  /** Authored text: titles and lower thirds. */
  text: z.boolean().default(false),
  /**
   * Captions that follow speech (`TextOperation.kind === 'caption'`).
   *
   * Separate from `text` because the two go to different places: a subtitle
   * file carries captions and nothing else, and an interchange format that can
   * hold a title may have no notion of a caption track at all.
   */
  captions: z.boolean().default(false),
  /**
   * Chapter and note markers on the timeline (`EditPlan.markers`).
   *
   * Declared so that a target which cannot hold them reports dropping them,
   * rather than an edit arriving without the chapters the plan was built around.
   */
  markers: z.boolean().default(false),
  basic_transition: z.boolean().default(false),
  transition_types: z.array(TransitionType).default([]),
  keyframes: z.boolean().default(false),
  masking: z.boolean().default(false),
  nested_sequence: z.boolean().default(false),
  speed_change: z.boolean().default(false),
  still_images: z.boolean().default(false),
  color_adjustment: z.boolean().default(false),
  audio_tracks: z.int().min(0).default(1),
  max_video_tracks: z.int().min(1).default(1),
  /** Whether the adapter can read the resulting timeline back for review. */
  reads_back_timeline: z.boolean().default(false),
  /** Whether the adapter renders the cut itself into something playable. */
  renders_preview: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
}).meta({ id: 'AdapterCapabilities', title: 'AdapterCapabilities' });
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>;

/** A capability the plan wanted but the target could not provide. */
export const CapabilityDowngrade = obj({
  operation_id: z.string().optional(),
  capability: z.string(),
  /** What the adapter did instead. */
  action: z.string(),
}).meta({ id: 'CapabilityDowngrade' });
export type CapabilityDowngrade = z.infer<typeof CapabilityDowngrade>;

export const AdapterArtifact = obj({
  path: z.string(),
  /**
   * `subtitles` is a caption file (SRT, WebVTT); `chapters` is a chapter list
   * for a video description. Both are sidecars: text beside the media, not a
   * timeline.
   */
  kind: z.enum(['project', 'interchange', 'script', 'report', 'preview', 'subtitles', 'chapters']),
  description: z.string().default(''),
  byte_size: z.int().min(0).optional(),
}).meta({ id: 'AdapterArtifact' });
export type AdapterArtifact = z.infer<typeof AdapterArtifact>;

export const ApplyResult = obj({
  adapter: z.string(),
  artifacts: z.array(AdapterArtifact).default([]),
  downgrades: z.array(CapabilityDowngrade).default([]),
  warnings: z.array(z.string()).default([]),
  /** How long the adapter took. */
  elapsed_ms: Milliseconds.optional(),
}).meta({ id: 'ApplyResult', title: 'ApplyResult' });
export type ApplyResult = z.infer<typeof ApplyResult>;

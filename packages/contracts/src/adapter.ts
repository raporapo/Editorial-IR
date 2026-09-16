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
   * application. A `file` adapter is always available; a `live` one may not be.
   */
  mode: z.enum(['file', 'live']),
  /** Extensions this adapter can write, e.g. `['.otio']`. */
  output_extensions: z.array(z.string()).default([]),

  text: z.boolean().default(false),
  captions: z.boolean().default(false),
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
  /** Whether the adapter can render preview frames. */
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
  kind: z.enum(['project', 'interchange', 'script', 'report', 'preview']),
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

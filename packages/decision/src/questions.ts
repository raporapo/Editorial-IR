import {
  EDITORIAL_FLAGS,
  EDITORIAL_METRICS,
  NARRATIVE_ROLES,
  type BooleanRequest,
  type ChoiceRequest,
  type EditorialFlag,
  type EditorialMetric,
  type ScoreRequest,
} from '@editorial-ir/contracts';

/**
 * The editorial decision taxonomy.
 *
 * This file is the reason the numbers in an Editorial IR mean anything. A model
 * asked to "rate the importance from 0 to 1" produces a number nobody can
 * interpret, compare between runs or calibrate. A model asked to place an event
 * on a scale whose every level is written down produces something two backends
 * can be compared on and a Skill rule can be written against.
 *
 * Changing the wording here changes what every stored score means, so it is
 * versioned with the IR and treated as contract, not prompt engineering.
 */

export const QUESTION_SET_VERSION = '0.1.0';

/** Five levels throughout: enough resolution to rank, few enough to define. */
const FIVE = 5;

export const METRIC_QUESTIONS: Record<EditorialMetric, ScoreRequest> = {
  story_importance: {
    question_id: 'story_importance',
    question: 'How much would the finished piece lose if this event were cut entirely?',
    levels: [
      { level: 0, label: 'nothing', description: 'Removing it changes nothing a viewer would notice.' },
      { level: 1, label: 'supporting', description: 'Pleasant texture, but the piece survives without it.' },
      { level: 2, label: 'informative', description: 'Carries something the viewer needs to follow what happens.' },
      { level: 3, label: 'significant', description: 'A turning point; the piece reads differently without it.' },
      { level: 4, label: 'essential', description: 'The piece does not work at all without it.' },
    ],
  },
  emotional_intensity: {
    question_id: 'emotional_intensity',
    question: 'How strongly is feeling expressed in this moment itself, regardless of its importance?',
    levels: [
      { level: 0, label: 'flat', description: 'Nothing is being felt or shown.' },
      { level: 1, label: 'mild', description: 'A trace: a small smile, a slight change in voice.' },
      { level: 2, label: 'clear', description: 'Feeling is plainly visible or audible.' },
      { level: 3, label: 'strong', description: 'Laughter, delight, distress; it carries the moment.' },
      { level: 4, label: 'peak', description: 'The most intense feeling in the whole material.' },
    ],
  },
  context_relevance: {
    question_id: 'context_relevance',
    question: "How well does this event serve what the user said this piece is for?",
    levels: [
      { level: 0, label: 'unrelated', description: 'Nothing to do with the stated occasion or goal.' },
      { level: 1, label: 'incidental', description: 'Happens to be in the material, but serves nothing stated.' },
      { level: 2, label: 'relevant', description: 'Fits the occasion and the tone that was asked for.' },
      { level: 3, label: 'on_point', description: 'Directly serves the stated goal.' },
      { level: 4, label: 'defining', description: 'This is the sort of moment the user made the piece for.' },
    ],
  },
  visual_quality: {
    question_id: 'visual_quality',
    question: 'How usable is the picture, ignoring what it shows?',
    levels: [
      { level: 0, label: 'unusable', description: 'Out of focus, blown out, black, or a whip pan.' },
      { level: 1, label: 'poor', description: 'Noticeably soft, shaky or badly exposed.' },
      { level: 2, label: 'acceptable', description: 'Nothing a viewer would remark on.' },
      { level: 3, label: 'good', description: 'Sharp, steady and well exposed.' },
      { level: 4, label: 'excellent', description: 'The best-looking material available.' },
    ],
  },
  audio_quality: {
    question_id: 'audio_quality',
    question: 'How usable is the sound, ignoring what is said?',
    levels: [
      { level: 0, label: 'unusable', description: 'Clipped, drowned in wind or noise, or silent when it should not be.' },
      { level: 1, label: 'poor', description: 'Intelligible only with effort.' },
      { level: 2, label: 'acceptable', description: 'Clear enough not to distract.' },
      { level: 3, label: 'good', description: 'Clean and easy to listen to.' },
      { level: 4, label: 'excellent', description: 'The best-sounding material available.' },
    ],
  },
  uniqueness: {
    question_id: 'uniqueness',
    question: 'How unlike the rest of the material is this event?',
    levels: [
      { level: 0, label: 'repeat', description: 'Another event covers the same thing as well or better.' },
      { level: 1, label: 'similar', description: 'Close to other material, with small differences.' },
      { level: 2, label: 'distinct', description: 'Clearly its own moment.' },
      { level: 3, label: 'rare', description: 'Nothing else in the material is much like it.' },
      { level: 4, label: 'singular', description: 'The only time anything like this happens.' },
    ],
  },
  redundancy: {
    question_id: 'redundancy',
    question: 'How much of this event is already covered by other material?',
    levels: [
      { level: 0, label: 'none', description: 'Nothing else covers it.' },
      { level: 1, label: 'slight', description: 'A little overlap with one other event.' },
      { level: 2, label: 'partial', description: 'Much of it appears elsewhere too.' },
      { level: 3, label: 'mostly', description: 'Another event says the same thing more clearly.' },
      { level: 4, label: 'duplicate', description: 'A second take of something already covered.' },
    ],
  },
  continuity_previous: {
    question_id: 'continuity_previous',
    question: 'How smoothly does this event follow the one before it?',
    levels: [
      { level: 0, label: 'jarring', description: 'Cutting into it from the previous event would jump badly.' },
      { level: 1, label: 'rough', description: 'Noticeably disconnected in place, subject or sound.' },
      { level: 2, label: 'workable', description: 'A cut would pass without comment.' },
      { level: 3, label: 'smooth', description: 'Same place and subject; the cut is invisible.' },
      { level: 4, label: 'continuous', description: 'They are one continuous action.' },
    ],
  },
  continuity_next: {
    question_id: 'continuity_next',
    question: 'How smoothly does the next event follow this one?',
    levels: [
      { level: 0, label: 'jarring', description: 'Cutting out of it would jump badly.' },
      { level: 1, label: 'rough', description: 'Noticeably disconnected in place, subject or sound.' },
      { level: 2, label: 'workable', description: 'A cut would pass without comment.' },
      { level: 3, label: 'smooth', description: 'Same place and subject; the cut is invisible.' },
      { level: 4, label: 'continuous', description: 'They are one continuous action.' },
    ],
  },
  information_density: {
    question_id: 'information_density',
    question: 'How much new information does this event deliver per second?',
    levels: [
      { level: 0, label: 'none', description: 'Nothing is being said or shown that the viewer did not have.' },
      { level: 1, label: 'sparse', description: 'A little, spread thinly.' },
      { level: 2, label: 'steady', description: 'A normal conversational pace of new information.' },
      { level: 3, label: 'dense', description: 'A lot, quickly.' },
      { level: 4, label: 'packed', description: 'So much that a viewer may need it slowed down.' },
    ],
  },
};

export const FLAG_QUESTIONS: Record<EditorialFlag, BooleanRequest> = {
  preserve: {
    question_id: 'preserve',
    statement: 'This event should survive into the finished piece.',
  },
  redundant: {
    question_id: 'redundant',
    statement: 'Another event covers this material as well or better, so this one can be dropped.',
  },
  establishing_shot: {
    question_id: 'establishing_shot',
    statement: 'This event establishes where we now are, before anything happens there.',
  },
  b_roll_candidate: {
    question_id: 'b_roll_candidate',
    statement: 'This event is worth seeing but not worth hearing, so it can run under other sound.',
  },
  opening_candidate: {
    question_id: 'opening_candidate',
    statement: 'This event could open the piece and make a viewer want to keep watching.',
  },
  ending_candidate: {
    question_id: 'ending_candidate',
    statement: 'This event could close the piece and leave it feeling finished.',
  },
  requires_previous_context: {
    question_id: 'requires_previous_context',
    statement: 'A viewer who had not seen the previous event would not understand this one.',
  },
  contains_dead_air: {
    question_id: 'contains_dead_air',
    statement: 'A noticeable stretch of this event is nothing happening, and could be trimmed.',
  },
};

export const NARRATIVE_ROLE_QUESTION: ChoiceRequest = {
  question_id: 'narrative_role',
  question: 'What structural job does this event do in the finished piece?',
  options: [
    { value: 'setup', description: 'Prepares the viewer for something that comes later.' },
    { value: 'context', description: 'Explains where we are or what is going on.' },
    { value: 'build_up', description: 'Raises anticipation toward something.' },
    { value: 'transition', description: 'Carries the viewer from one place or topic to another.' },
    { value: 'payoff', description: 'Delivers what an earlier event promised.' },
    { value: 'climax', description: 'The high point of the whole piece.' },
    { value: 'reaction', description: 'Someone responding to what just happened.' },
    { value: 'resolution', description: 'Settles things after the high point.' },
    { value: 'ending', description: 'Closes the piece.' },
    { value: 'filler', description: 'Occupies time without doing any of the above.' },
  ],
};

/** Sanity checks that the registry covers the contract, verified by tests. */
export const QUESTION_COVERAGE = {
  metrics: EDITORIAL_METRICS,
  flags: EDITORIAL_FLAGS,
  roles: NARRATIVE_ROLES,
} as const;

export function metricQuestion(metric: EditorialMetric): ScoreRequest {
  return METRIC_QUESTIONS[metric];
}

export function flagQuestion(flag: EditorialFlag): BooleanRequest {
  return FLAG_QUESTIONS[flag];
}

export { FIVE as DEFAULT_LEVEL_COUNT };

import type { EventState } from '@editorial-ir/contracts';
import type { BatchAnswers, BatchRequest, EditorialDecisionModel } from '../types.js';

/** Answers a batch request by asking a backend one question at a time. */
export async function assessViaPrimitives(
  model: EditorialDecisionModel,
  state: EventState,
  request: BatchRequest,
): Promise<BatchAnswers> {
  const answers: BatchAnswers = { scores: {}, booleans: {} };
  for (const question of request.scores) {
    answers.scores[question.question_id] = await model.score(state, question);
  }
  for (const question of request.booleans) {
    answers.booleans[question.question_id] = await model.booleanProbability(state, question);
  }
  if (request.choice) answers.choice = await model.choice(state, request.choice);
  answers.confidence = model.identity.baseConfidence;
  return answers;
}

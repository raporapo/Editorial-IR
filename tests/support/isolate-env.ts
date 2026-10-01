/**
 * Runs before every test file: no model the developer configured reaches a test.
 *
 * Tests call `main()` and `compileProject` directly, and both read the model
 * variables from `process.env`. With a real key in the shell — `OEA_GEMINI_API_KEY`
 * set in a hosted environment, say — the suite sent the worked example to Gemini,
 * paid for it, and ran for ten minutes instead of twenty-five seconds. A test that
 * needs one of these sets it itself.
 */
const PREFIXES = [
  'OEA_VLM',
  'OEA_DECISION',
  'OEA_EMBED',
  'OEA_AGENT',
  'OEA_JEV',
  'OEA_GEMINI',
  'OEA_TRANSCRIBE',
];
const NAMES = ['OEA_PROVIDER', 'OEA_PERCEPTION', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

for (const name of Object.keys(process.env)) {
  if (NAMES.includes(name) || PREFIXES.some((prefix) => name.startsWith(prefix))) {
    delete process.env[name];
  }
}

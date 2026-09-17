// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'schemas/**',
      'services/**',
      '**/*.d.ts',
      // Plain scripts, outside any TypeScript project: type-aware linting has
      // nothing to read them with.
      '**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Everything here that decides an order is part of the output, and the
      // first thing the compiler promises is that the same input produces
      // byte-identical output. `localeCompare` reads a collation from the
      // environment, and collations disagree: `ä` sorts before `z` under en-US
      // and after it under sv-SE. `compareText` is the same order everywhere.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='localeCompare']",
          message:
            'localeCompare depends on the machine’s locale; use compareText from @editorial-ir/contracts.',
        },
      ],
    },
  },
  {
    // Tests walk parsed JSON from files on disk — an OTIO timeline, a written
    // plan — and typing every intermediate step there adds noise without
    // catching anything. The rules that matter in source stay on everywhere else.
    files: ['**/test/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // A test is allowed to call localeCompare, because showing that two
      // collations disagree is how the rule above is justified.
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

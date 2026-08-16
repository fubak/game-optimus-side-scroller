import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files live outside the tsconfig `include` globs but still deserve linting.
          allowDefaultProject: ['*.js', '*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Newly added variants of a union/enum must break the build until they are handled. The
      // `default: { const exhaustive: never = value; ... }` guard stays allowed on purpose: it also
      // catches bad values that sneak in at runtime (e.g. a corrupt save or hand-written level).
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { allowDefaultCaseForExhaustiveSwitch: true, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Keep imports at the top of the module: no dynamic `import()` inside function bodies and
      // no inline `import('./x').Type` type references.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration ImportExpression',
          message: 'Keep imports at the top of the module; no inline dynamic imports.',
        },
        {
          selector: 'ArrowFunctionExpression ImportExpression',
          message: 'Keep imports at the top of the module; no inline dynamic imports.',
        },
        {
          selector: 'FunctionExpression ImportExpression',
          message: 'Keep imports at the top of the module; no inline dynamic imports.',
        },
        {
          selector: 'TSImportType',
          message: 'Use a top-level `import type` instead of an inline import type.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['*.config.ts', '*.config.js', 'scripts/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Developer scripts exist to print things.
      'no-console': 'off',
    },
  },
  prettier,
);

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'release/**', 'release2/**', 'release-final/**', 'release-manual/**', 'rel-*/**', 'electron-host/main.cjs', 'electron-host/metadata-worker.cjs', 'electron-host/mcp-mysql.cjs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // These diagnostics are advisory until the existing renderer is migrated
      // to the React Compiler's stricter purity/effect model.
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Colours come from the theme tokens (src/styles/theme.css, DESIGN.md), never a raw hex.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/components/dev/**'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/]',
          message: 'Use a theme token (text-body, bg-success-soft, var(--brand), …) instead of a raw hex colour. See DESIGN.md.',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/]',
          message: 'Use a theme token (text-body, bg-success-soft, var(--brand), …) instead of a raw hex colour. See DESIGN.md.',
        },
      ],
    },
  },
])

import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  // The dependencies, the build, the wasm builds' generated glue, cargo's outputs, and the
  // end-to-end suite's results.
  {
    ignores: [
      "node_modules/",
      "dist/",
      "wasm/pkg/",
      "wasm/target/",
      "device/pkg/",
      "device/target/",
      "e2e/device/target/",
      "test-results/",
      "playwright-report/",
    ],
  },

  js.configs.recommended,

  // TypeScript, type-checked against tsconfig.json.
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  jsxA11y.flatConfigs.recommended,

  {
    settings: { react: { version: "detect" } },
    rules: {
      "react/prop-types": "off",
      "react/button-has-type": "warn",
      "react/self-closing-comp": "warn",
      "react/jsx-boolean-value": "warn",
      "react/jsx-curly-brace-presence": "warn",
      "react/jsx-fragments": "warn",
      "react/jsx-no-useless-fragment": ["warn", { allowExpressions: true }],
      "react/jsx-pascal-case": "warn",
      "react/no-unstable-nested-components": "error",
      "react/function-component-definition": "warn",
      "react/hook-use-state": "warn",
    },
  },

  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/default-param-last": "error",
      "@typescript-eslint/no-loop-func": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-useless-constructor": "error",
      "@typescript-eslint/consistent-type-exports": "warn",
      "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: true }],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "enumMember", format: ["PascalCase"] },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
      ],

      // The code asserts what it has just established (a lookup's result, a
      // parsed JSON's type), passes methods that do not use `this` as
      // callbacks, starts a promise from an effect or a handler without
      // awaiting it, and keeps no-op functions as defaults.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
  },

  {
    rules: {
      "array-callback-return": ["error", { allowImplicit: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-alert": "error",
      "no-caller": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-extra-bind": "error",
      "no-implied-eval": "error",
      "no-new": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-param-reassign": "error",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-return": "warn",
      "no-var": "error",
      "prefer-const": "warn",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "prefer-template": "warn",
      "object-shorthand": "warn",
    },
  },

  // This file is the one JavaScript file: no tsconfig includes it, so it is
  // linted without type information, as the Node module it is.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.mjs"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      parserOptions: { projectService: false, project: false },
      globals: { ...globals.node },
    },
  },
];

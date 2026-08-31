// eslint.config.js
import globals from "globals";
import pluginJs from "@eslint/js";
import noFloatingPromise from "eslint-plugin-no-floating-promise";

// The environment is split deliberately: everything outside src/mindcraft/public
// runs in Node (process, Buffer, setTimeout-with-unref), and only the dashboard
// runs in a browser. Configured as one browser project, the linter reported
// ~240 phantom no-undef errors on a clean tree and nobody could see a real one.
// ecmaVersion must be >= 2022 — every model provider declares `static prefix`.
const rules = {
  "no-undef": "error",              // Disallow the use of undeclared variables or functions.
  "semi": ["error", "always"],      // Require the use of semicolons at the end of statements.
  "curly": "off",                   // Do not enforce the use of curly braces around blocks of code.
  "no-unused-vars": "off",          // Disable warnings for unused variables.
  "no-unreachable": "off",          // Disable warnings for unreachable code.
  "require-await": "error",         // Disallow async functions which have no await expression
  "no-floating-promise/no-floating-promise": "error", // Disallow Promises without error handling or awaiting
};

/** @type {import('eslint').Linter.Config[]} */
export default [
  // First, import the recommended configuration
  pluginJs.configs.recommended,

  // Node: the agent, the mindserver, the tests, the entry points.
  {
    // .mjs too: tools/ uses it, and without this they fall through to the
    // base config and lose the Node globals.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ignores: ["src/mindcraft/public/**"],
    plugins: { "no-floating-promise": noFloatingPromise },
    languageOptions: {
      // Compartment is installed as a global by SES lockdown().
      globals: { ...globals.node, Compartment: "readonly" },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules,
  },

  // The dashboard: classic scripts loaded by index.html, no modules.
  {
    files: ["src/mindcraft/public/**/*.js"],
    plugins: { "no-floating-promise": noFloatingPromise },
    languageOptions: {
      globals: { ...globals.browser },
      ecmaVersion: 2022,
      sourceType: "script",
    },
    rules,
  },
];

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import architecturePlugin from "./eslint-rules/architecture/index.mjs";
import effectPlugin from "./eslint-rules/effect/index.mjs";

const typeScriptFiles = ["**/*.ts", "**/*.tsx"];
const localPluginTypeScriptFiles = ["eslint-rules/**/*.{mts,cts}"];
const localPluginTypeScript = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: localPluginTypeScriptFiles,
}));
const typeChecked = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: typeScriptFiles,
}));

export default tseslint.config(
  {
    ignores: [
      // The web bundle (bun run build:web)
      "packages/app/dist/**",
      // Recorded CI artifacts the adapters read
      "fixtures/**",
      // Local data, S3 cache and SQLite
      ".data/**",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...localPluginTypeScript,
  ...typeChecked,
  {
    files: typeScriptFiles,
    plugins: {
      architecture: architecturePlugin,
    },
    languageOptions: {
      globals: { ...globals.bunBuiltin, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "architecture/no-double-assertion-through-unknown": "error",
      // The adapters narrow parsed JSON with `as` in a few places; Schema decoding at those
      // boundaries is day-2 work. Until then the rule stays off, as in hyperstition.
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      // Allows Effect's `interface X extends Schema.Schema.Type<typeof X> {}`.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    plugins: {
      effect: effectPlugin,
    },
    rules: {
      "architecture/no-unknown-effect-channels": "error",
      "effect/no-direct-throw-in-gen": "error",
      "effect/no-sync-schema-decode-in-gen": "error",
      "effect/no-throwing-operation-in-sync": "error",
      "effect/require-promise-rejection-handler": "error",
    },
  },
  {
    files: ["packages/*/test/**/*.ts"],
    rules: {
      "architecture/no-test-contract-replacements": "error",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);

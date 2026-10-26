import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-demo", "notebooks", ".venv"] },
  { files: ["scripts/**"], languageOptions: { globals: { console: "readonly", performance: "readonly" } } },
  eslint.configs.recommended,
  tseslint.configs.recommended,
);

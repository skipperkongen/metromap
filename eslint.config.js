import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-demo", "notebooks", ".venv"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
);

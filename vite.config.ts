import { defineConfig, type Plugin } from "vite";

// The browser demo. `npm run demo` serves it, `npm run demo:build` writes a single
// self-contained dist-demo/index.html that also works when opened from disk.
export default defineConfig({
  root: "demo",
  base: "./",
  plugins: [inlineAssets()],
  build: {
    outDir: "../dist-demo",
    emptyOutDir: true,
    modulePreload: false,
  },
});

/**
 * Browsers refuse to load module scripts and stylesheets from file:// pages,
 * so move the built JS and CSS into index.html itself.
 */
function inlineAssets(): Plugin {
  return {
    name: "inline-assets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") return;
      let html = String(page.source);
      for (const [fileName, file] of Object.entries(bundle)) {
        const tag = new RegExp(`<(script|link)[^>]*(src|href)="\\./${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>(</script>)?`);
        if (file.type === "chunk" && fileName.endsWith(".js")) {
          // "</script" inside the code would end the inline tag early.
          const code = file.code.replace(/<\/script/gi, "<\\/script");
          html = html.replace(tag, () => `<script type="module">${code}</script>`);
          delete bundle[fileName];
        } else if (file.type === "asset" && fileName.endsWith(".css")) {
          html = html.replace(tag, () => `<style>${String(file.source)}</style>`);
          delete bundle[fileName];
        }
      }
      page.source = html;
    },
  };
}

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** 版本号与仓库根保持一致 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  // 产物由 Rust 侧的 webui 模块托管，使用相对路径避免子路径部署问题
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5390,
    // 开发时把 API 代理到 Aster 后端
    proxy: {
      '/api': {
        target: process.env.ASTER_API ?? 'http://127.0.0.1:5311',
        changeOrigin: true,
      },
    },
  },
});

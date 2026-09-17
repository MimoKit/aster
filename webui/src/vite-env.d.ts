/// <reference types="vite/client" />

/** 由 Vite define 注入的版本号 */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** 插件市场清单地址覆盖 */
  readonly VITE_ASTER_MARKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

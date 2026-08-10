import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Configuration alignée sur les attentes de Tauri :
// port fixe, pas de nettoyage d'écran (les erreurs Rust restent lisibles).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Le dossier Rust est surveillé par cargo, pas par Vite.
      ignored: ['**/src-tauri/**'],
    },
  },
  // Un seul .env, à la racine du monorepo, partagé avec l'API.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    // Remontée au serveur à l'enrôlement : savoir quelle version tourne sur
    // quelle caisse est indispensable pour diagnostiquer un parc.
    __APP_VERSION__: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
  },
  build: {
    // Cible des WebViews embarquées : WebView2 (Windows) et WebKitGTK (Linux).
    target: 'esnext',
    sourcemap: true,
  },
});

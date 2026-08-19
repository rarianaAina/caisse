import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Le back-office est une page web ORDINAIRE, servie à part de l'API.
 *
 * Il n'est pas empaqueté dans l'API : un tableau de bord qui tombe ne doit
 * jamais pouvoir empêcher une caisse de remonter ses ventes. Les deux se
 * déploient et redémarrent indépendamment.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Un seul .env à la racine du monorepo, partagé avec l'API et la caisse.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  server: { port: 5174, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});

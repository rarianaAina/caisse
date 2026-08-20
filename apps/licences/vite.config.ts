import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Outil d'émission des licences — application de bureau.
 *
 * Port distinct de celui de la caisse (1420) : les deux peuvent tourner en même
 * temps sur la machine de l'éditeur, et un port partagé ferait échouer la
 * seconde sans dire pourquoi.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});

import { type Options, defineConfig } from 'tsup';

/**
 * Double format : ESM pour Vite (desktop), CJS pour NestJS (api).
 *
 * Les deux sorties ne traitent pas `uuid` de la même façon, et c'est
 * volontaire :
 *
 *  - **ESM** le garde externe. L'inclure ferait entrer son import de `crypto`
 *    (Node) dans le paquet chargé par la WebView, et la compilation du bureau
 *    échoue alors sur « randomFillSync is not exported ». Vite résout lui-même
 *    la variante navigateur d'`uuid`.
 *  - **CJS** l'inclut, ce qui rend `dist` autonome. L'image du serveur recopie
 *    le paquet partagé sans son arbre de dépendances : un `require("uuid")`
 *    résiduel y serait introuvable.
 */
const commun: Options = {
  entry: ['src/index.ts'],
  sourcemap: true,
  target: 'es2022',
};

export default defineConfig([
  { ...commun, format: ['esm'], dts: true, clean: true },
  // `clean` seulement dans la première passe : la seconde effacerait la sortie
  // ESM qui vient d'être produite.
  { ...commun, format: ['cjs'], noExternal: ['uuid'], clean: false },
]);

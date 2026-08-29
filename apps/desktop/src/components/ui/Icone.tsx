import type { ReactNode } from 'react';

/**
 * Jeu d'icônes du logiciel.
 *
 * POURQUOI IL EXISTE. Les icônes étaient jusqu'ici des CARACTÈRES : ✕, ⌕, ←,
 * ●, ⚠. Trois défauts que rien ne rattrape — leur dessin change d'un système à
 * l'autre, leur graisse ne suit pas celle du texte, et leur alignement vertical
 * dépend de la police installée. Un logiciel dont les icônes sautent d'un poste
 * à l'autre paraît bricolé, quelle que soit la qualité du reste.
 *
 * POURQUOI EN LIGNE, ET PAS UNE DÉPENDANCE. Une caisse travaille hors ligne et
 * son binaire doit rester petit : ces vingt-huit tracés pèsent quelques
 * kilo-octets, là où une bibliothèque complète en pèse des centaines pour
 * quatre cents icônes dont on n'utilisera jamais aucune.
 *
 * Tracés de Lucide (licence ISC), à 24 pixels, trait de 2. Les attributs
 * communs vivent ICI, une seule fois : c'est ce qui garantit que toutes les
 * icônes du logiciel ont exactement la même graisse.
 */

const TRACES: Record<string, ReactNode> = {
  achats: (
    <>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /> <path d="M15 18H9" />{' '}
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />{' '}
      <circle cx="17" cy="18" r="2" /> <circle cx="7" cy="18" r="2" />
    </>
  ),
  alerte: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />{' '}
      <path d="M12 9v4" /> <path d="M12 17h.01" />
    </>
  ),
  attention: (
    <>
      <circle cx="12" cy="12" r="10" /> <line x1="12" x2="12" y1="8" y2="12" />{' '}
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  baisse: (
    <>
      <path d="m7 7 10 10" /> <path d="M17 7v10H7" />
    </>
  ),
  catalogue: (
    <>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />{' '}
      <path d="M12 22V12" /> <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />{' '}
      <path d="m7.5 4.27 9 5.15" />
    </>
  ),
  chevronBas: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  chevronDroite: (
    <>
      <path d="m9 18 6-6-6-6" />
    </>
  ),
  chevronGauche: (
    <>
      <path d="m15 18-6-6 6-6" />
    </>
  ),
  clients: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /> <circle cx="9" cy="7" r="4" />{' '}
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" /> <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  coche: (
    <>
      <path d="M20 6 9 17l-5-5" />
    </>
  ),
  fermer: (
    <>
      <path d="M18 6 6 18" /> <path d="m6 6 12 12" />
    </>
  ),
  hausse: (
    <>
      <path d="M7 7h10v10" /> <path d="M7 17 17 7" />
    </>
  ),
  historique: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />{' '}
      <path d="M12 7v5l4 2" />
    </>
  ),
  moins: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  personnel: (
    <>
      <circle cx="18" cy="15" r="3" /> <circle cx="9" cy="7" r="4" />{' '}
      <path d="M10 15H6a4 4 0 0 0-4 4v2" /> <path d="m21.7 16.4-.9-.3" />{' '}
      <path d="m15.2 13.9-.9-.3" /> <path d="m16.6 18.7.3-.9" /> <path d="m19.1 12.2.3-.9" />{' '}
      <path d="m19.6 18.7-.4-1" /> <path d="m16.8 12.3-.4-1" /> <path d="m14.3 16.6 1-.4" />{' '}
      <path d="m20.7 13.8 1-.4" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" /> <path d="M12 5v14" />
    </>
  ),
  promotions: (
    <>
      <line x1="19" x2="5" y1="5" y2="19" /> <circle cx="6.5" cy="6.5" r="2.5" />{' '}
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  quitter: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /> <polyline points="16 17 21 12 16 7" />{' '}
      <line x1="21" x2="9" y1="12" y2="12" />
    </>
  ),
  rapports: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />{' '}
      <path d="M14 2v4a2 2 0 0 0 2 2h4" /> <path d="M10 9H8" /> <path d="M16 13H8" />{' '}
      <path d="M16 17H8" />
    </>
  ),
  recherche: (
    <>
      <circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />
    </>
  ),
  reglages: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />{' '}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  salle: (
    <>
      <path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8" />{' '}
      <path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7" />{' '}
      <path d="m2.1 21.8 6.4-6.3" /> <path d="m19 5-7 7" />
    </>
  ),
  stock: (
    <>
      <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z" />{' '}
      <path d="m7 16.5-4.74-2.85" /> <path d="m7 16.5 5-3" /> <path d="M7 16.5v5.17" />{' '}
      <path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z" />{' '}
      <path d="m17 16.5-5-3" /> <path d="m17 16.5 4.74-2.85" /> <path d="M17 16.5v5.17" />{' '}
      <path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z" />{' '}
      <path d="M12 8 7.26 5.15" /> <path d="m12 8 4.74-2.85" /> <path d="M12 13.5V8" />
    </>
  ),
  synchro: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /> <path d="M21 3v5h-5" />{' '}
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /> <path d="M8 16H3v5" />
    </>
  ),
  tableauDeBord: (
    <>
      <rect width="7" height="9" x="3" y="3" rx="1" />{' '}
      <rect width="7" height="5" x="14" y="3" rx="1" />{' '}
      <rect width="7" height="9" x="14" y="12" rx="1" />{' '}
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </>
  ),
  tiroir: (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />{' '}
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  vente: (
    <>
      <circle cx="8" cy="21" r="1" /> <circle cx="19" cy="21" r="1" />{' '}
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </>
  ),
  verrou: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />{' '}
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
};

export type NomIcone = keyof typeof TRACES;

export function Icone({
  nom,
  taille = 20,
  className = '',
}: {
  nom: NomIcone;
  /** En pixels. 20 par défaut : la taille du texte courant. */
  taille?: number;
  className?: string;
}) {
  return (
    <svg
      width={taille}
      height={taille}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Décoratives par défaut : une icône accompagnée de son libellé serait
      // lue deux fois par un lecteur d'écran.
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {TRACES[nom]}
    </svg>
  );
}

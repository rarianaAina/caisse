import { useState } from 'react';
import { can } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { EnTetePage } from '../../components/ui/EnTetePage';
import { Icone, type NomIcone } from '../../components/ui/Icone';
import { CompanyPanel } from './CompanyPanel';
import { BusinessProfilePanel } from './BusinessProfilePanel';
import { PrinterSettingsScreen } from './PrinterSettingsScreen';
import { BackupPanel } from './BackupPanel';
import { MaintenancePanel } from './MaintenancePanel';
import { UpdatePanel } from './UpdatePanel';
import { UsersPanel } from './UsersPanel';
import { DevicesPanel } from './DevicesPanel';

/**
 * Réglages, rangés.
 *
 * POURQUOI CET ÉCRAN EXISTE. Les réglages étaient UNE page empilant huit
 * panneaux — identité, imprimante, mise en page du ticket, balance,
 * maintenance, sauvegarde, mise à jour, serveur de salle. Pour changer une
 * adresse d'imprimante il fallait défiler devant tout le reste, et pour
 * retrouver la sauvegarde il fallait se souvenir qu'elle était « vers le bas ».
 * Un réglage qu'on ne retrouve pas est un réglage qui n'existe pas.
 *
 * QUATRE SECTIONS, PAS HUIT. Le regroupement suit ce qu'on vient faire, pas
 * l'ordre dans lequel les panneaux ont été écrits : l'établissement, le
 * matériel du poste, les gens, et l'entretien du logiciel.
 */

type Section = 'etablissement' | 'materiel' | 'gens' | 'entretien';

const SECTIONS: { id: Section; label: string; icone: NomIcone; detail: string }[] = [
  {
    id: 'etablissement',
    label: 'Établissement',
    icone: 'reglages',
    detail: 'Nom, type de commerce',
  },
  { id: 'materiel', label: 'Matériel', icone: 'catalogue', detail: 'Imprimante, ticket, balance' },
  { id: 'gens', label: 'Personnel et postes', icone: 'personnel', detail: 'Comptes, caisses' },
  { id: 'entretien', label: 'Entretien', icone: 'synchro', detail: 'Sauvegarde, mise à jour' },
];

export function SettingsScreen({
  session,
  db,
  version,
}: {
  session: LocalSession;
  db: SqlExecutor;
  version: string;
}) {
  const [section, setSection] = useState<Section>('etablissement');

  // Les comptes et les postes ne concernent que qui les administre : proposer
  // une section vide vaut moins que ne pas la proposer.
  const gereLesGens = can(session.user.role, 'manageUsers');
  const visibles = SECTIONS.filter((entry) => entry.id !== 'gens' || gereLesGens);

  return (
    <div className="space-y-6">
      <EnTetePage titre="Réglages" sous="Ce qui vaut pour ce poste, et ce qui vaut pour tous." />

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        {/* Sous-navigation en colonne : les intitulés sont trop longs pour des
            onglets, et les tronquer ferait perdre ce qui les distingue. */}
        <nav aria-label="Sections des réglages" className="flex flex-col gap-1">
          {visibles.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              aria-current={section === entry.id ? 'page' : undefined}
              className={`flex items-start gap-3 rounded-xl px-4 py-3 text-left transition ${
                section === entry.id
                  ? 'bg-white shadow-carte'
                  : 'text-ardoise-600 hover:bg-white/60'
              }`}
            >
              <Icone
                nom={entry.icone}
                taille={18}
                className={`mt-0.5 ${section === entry.id ? 'text-caisse-600' : 'text-ardoise-400'}`}
              />
              <span className="min-w-0">
                <span
                  className={`block text-sm font-semibold ${
                    section === entry.id ? 'text-ardoise-900' : 'text-ardoise-700'
                  }`}
                >
                  {entry.label}
                </span>
                <span className="block text-xs text-ardoise-400">{entry.detail}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-5">
          {section === 'etablissement' && (
            <>
              <CompanyPanel session={session} db={db} />
              <BusinessProfilePanel db={db} />
            </>
          )}
          {section === 'materiel' && <PrinterSettingsScreen session={session} db={db} />}
          {section === 'gens' && (
            <>
              <UsersPanel session={session} db={db} />
              <DevicesPanel session={session} db={db} />
            </>
          )}
          {section === 'entretien' && (
            <>
              <BackupPanel db={db} />
              <MaintenancePanel session={session} db={db} />
              <UpdatePanel currentVersion={version} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

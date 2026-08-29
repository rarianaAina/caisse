import { useState } from 'react';
import { LICENCE_GRACE_DAYS, type LicenceStatus, installationCode } from '@caisse/shared';

/**
 * Activation du poste.
 *
 * CET ÉCRAN EST LA PORTE DE SECOURS. Quand la licence bloque, c'est le seul
 * écran atteignable — et c'est délibéré : un commerçant enfermé dehors doit
 * pouvoir être débloqué au téléphone en trente secondes. Il lit son code
 * d'installation, on lui renvoie une clé, il la colle, il rouvre sa caisse.
 *
 * Sans cette issue, un blocage dur serait une promesse de catastrophe : une
 * échéance mal calculée un samedi midi, et le commerçant n'a aucun recours.
 */
export function LicenceScreen({
  companyId,
  companyName,
  status,
  onActivate,
  onClose,
}: {
  companyId: string;
  companyName: string;
  status: LicenceStatus;
  onActivate: (cle: string) => Promise<LicenceStatus>;
  /** Absent quand la licence bloque : on ne sort pas de cet écran. */
  onClose?: () => void;
}) {
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [refus, setRefus] = useState<string | null>(null);
  const code = installationCode(companyId);

  const activer = async (): Promise<void> => {
    setBusy(true);
    setRefus(null);
    try {
      const resultat = await onActivate(saisie);
      if (resultat.state === 'invalide' || resultat.state === 'autre-entreprise') {
        setRefus(resultat.reason ?? 'Clé refusée.');
        return;
      }
      setSaisie('');
    } finally {
      setBusy(false);
    }
  };

  const copier = (): void => {
    void navigator.clipboard?.writeText(code).catch(() => undefined);
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-ardoise-100 p-6">
      <div className="w-full max-w-xl rounded-2xl bg-white p-8 shadow-flottant">
        <h1 className="text-xl font-semibold text-ardoise-900">Activation</h1>
        <p className="mt-1 text-sm text-ardoise-500">{companyName}</p>

        <Etat status={status} />

        {/* Le code d'installation d'abord : c'est ce qu'on demande au
            commerçant, et il doit pouvoir le lire au téléphone sans chercher. */}
        <div className="mt-6 rounded-xl border border-ardoise-200 bg-ardoise-50 p-4">
          <p className="text-sm font-medium text-ardoise-700">Code d’installation</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="font-mono text-2xl font-semibold tracking-wider text-ardoise-900">
              {code}
            </span>
            <button
              type="button"
              onClick={copier}
              className="rounded-lg border border-ardoise-300 bg-white px-3 py-1.5 text-sm font-medium text-ardoise-700"
            >
              Copier
            </button>
          </div>
          <p className="mt-2 text-sm text-ardoise-500">
            Communiquez-le à votre fournisseur pour obtenir une clé. Une clé émise pour une autre
            installation sera refusée.
          </p>
        </div>

        <label className="mt-6 block text-sm font-medium text-ardoise-700" htmlFor="cle">
          Clé d’activation
          <textarea
            id="cle"
            value={saisie}
            onChange={(event) => setSaisie(event.target.value)}
            rows={4}
            placeholder="CAISSE-1..."
            spellCheck={false}
            className="mt-1 w-full rounded-xl border border-ardoise-300 p-3 font-mono text-xs outline-none focus:border-caisse-500"
          />
        </label>
        <p className="text-sm text-ardoise-500">
          Collez-la telle qu’elle vous a été envoyée. Les retours à la ligne n’ont pas d’importance.
        </p>

        {refus && (
          <p role="alert" className="mt-4 rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
            {refus}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void activer()}
            disabled={busy || saisie.trim() === ''}
            className="flex-1 rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
          >
            {busy ? 'Vérification…' : 'Activer ce poste'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ardoise-300 px-5 py-3 font-medium text-ardoise-700"
            >
              Fermer
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

/** Ce que dit l'état courant, en clair et sans jargon. */
function Etat({ status }: { status: LicenceStatus }) {
  const { ton, titre, detail } = decrire(status);
  const couleurs: Record<string, string> = {
    ok: 'bg-succes-50 text-succes-800',
    alerte: 'bg-alerte-50 text-alerte-900',
    bloque: 'bg-danger-50 text-danger-800',
  };

  return (
    <div className={`mt-5 rounded-xl p-4 ${couleurs[ton] ?? ''}`}>
      <p className="font-medium">{titre}</p>
      <p className="mt-1 text-sm">{detail}</p>
    </div>
  );
}

function decrire(status: LicenceStatus): { ton: string; titre: string; detail: string } {
  const jours = (n: number): string => `${String(n)} jour${n > 1 ? 's' : ''}`;

  switch (status.state) {
    case 'valide': {
      const essai = status.payload?.s === 'essai';
      return {
        ton: (status.daysLeft ?? 0) <= 30 ? 'alerte' : 'ok',
        titre: essai ? 'Période d’essai' : `Poste activé — ${status.payload?.n ?? ''}`,
        detail: essai
          ? `Il reste ${jours(status.daysLeft ?? 0)}. Toutes les fonctions sont ouvertes.`
          : `Valable jusqu’au ${status.payload?.e ?? ''}, soit ${jours(status.daysLeft ?? 0)}.`,
      };
    }
    case 'grace':
      return {
        ton: 'alerte',
        titre: 'Licence échue',
        detail:
          `Elle a expiré le ${status.payload?.e ?? ''}. Tout fonctionne encore pendant ` +
          `${jours(status.graceLeft ?? LICENCE_GRACE_DAYS)}, puis la caisse se fermera.`,
      };
    case 'expiree':
      return {
        ton: 'bloque',
        titre: status.payload?.s === 'essai' ? 'Période d’essai terminée' : 'Licence expirée',
        detail:
          'La caisse est fermée. Vos données sont intactes et vous les retrouverez ' +
          'intégralement dès l’activation.',
      };
    case 'autre-entreprise':
      return {
        ton: 'bloque',
        titre: 'Clé émise pour une autre installation',
        detail: status.reason ?? 'Vérifiez le code d’installation communiqué.',
      };
    case 'invalide':
      return {
        ton: 'bloque',
        titre: 'Clé refusée',
        detail: status.reason ?? 'Cette clé n’a pas pu être vérifiée.',
      };
    default:
      return {
        ton: 'alerte',
        titre: 'Poste non activé',
        detail: 'Saisissez la clé qui vous a été communiquée.',
      };
  }
}

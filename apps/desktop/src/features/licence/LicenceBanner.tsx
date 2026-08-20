import type { LicenceStatus } from '@caisse/shared';

/**
 * Bandeau d'échéance.
 *
 * POURQUOI IL EXISTE : ce logiciel se ferme à l'expiration. Une fermeture qui
 * surprend est une faute — le commerçant doit avoir été prévenu longtemps, puis
 * de plus en plus fort. Le bandeau apparaît un mois avant, et ne se ferme pas :
 * un avertissement qu'on peut faire taire n'avertit personne.
 *
 * Il ne s'affiche JAMAIS quand tout va bien. Un bandeau permanent devient un
 * décor, et le jour où il dit quelque chose d'important, plus personne ne le
 * lit.
 */
export function LicenceBanner({ status, seuil }: { status: LicenceStatus; seuil: number }) {
  if (status.state === 'grace') {
    const jours = status.graceLeft ?? 0;
    return (
      <div className="border-b border-rose-200 bg-rose-50 px-6 py-2.5 text-sm text-rose-900">
        <b>Licence échue.</b> La caisse se fermera dans {jours} jour{jours > 1 ? 's' : ''}.
        Contactez votre fournisseur — vos données sont intactes et le resteront.
      </div>
    );
  }

  if (status.state !== 'valide') return null;

  const jours = status.daysLeft ?? 0;
  if (jours > seuil) return null;

  const essai = status.payload?.s === 'essai';
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900">
      {essai ? 'Période d’essai : ' : 'Licence : '}
      il reste{' '}
      <b>
        {jours} jour{jours > 1 ? 's' : ''}
      </b>
      {status.payload?.e ? ` (jusqu’au ${status.payload.e})` : ''}.{' '}
      {essai
        ? 'Passé ce délai, la caisse se fermera.'
        : 'Pensez au renouvellement avant l’échéance.'}
    </div>
  );
}

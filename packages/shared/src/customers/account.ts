import type { Cents } from '../money/index.js';
import { sumCents } from '../money/index.js';
import type { Customer, CustomerAccountMovement } from '../domain/customer.js';

/**
 * Arithmétique de l'ardoise — fonctions pures, entiers uniquement.
 *
 * Le solde affiché à la caisse, celui imprimé sur un relevé et celui que
 * recalculera le serveur viennent tous d'ici. Un écart entre eux se solderait
 * par une discussion avec un client à qui l'on réclame ce qu'il a déjà payé.
 */

/** Solde d'un compte : somme du journal. Positif = le client doit. */
export function accountBalance(movements: readonly CustomerAccountMovement[]): Cents {
  return sumCents(movements.map((movement) => movement.amountCents));
}

/**
 * Encours encore autorisé. `null` = pas de plafond.
 *
 * Un plafond atteint renvoie 0, jamais un nombre négatif : « il peut encore
 * prendre pour -3 000 Ar » ne veut rien dire au comptoir.
 */
export function creditRemaining(customer: Customer, balanceCents: Cents): Cents | null {
  if (customer.creditLimitCents === null) return null;
  return Math.max(0, customer.creditLimitCents - balanceCents);
}

export type CreditVerdict =
  { allowed: true } | { allowed: false; reason: 'no-credit' | 'over-limit'; remainingCents: Cents };

/**
 * Le client peut-il emporter cette vente à crédit ?
 *
 * POURQUOI C'EST BLOQUANT, ALORS QUE L'ENCAISSEMENT NE L'EST JAMAIS : refuser
 * un paiement ferait attendre un client qui tend son argent, ce qui n'a aucun
 * sens. Accorder un crédit est l'inverse — c'est une décision commerciale, prise
 * à l'avance, et un plafond qu'on peut dépasser d'un clic n'est pas un plafond.
 * Le responsable reste libre de le relever ; il le fait alors sciemment.
 */
export function checkCredit(
  customer: Customer,
  balanceCents: Cents,
  amountCents: Cents,
): CreditVerdict {
  const remaining = creditRemaining(customer, balanceCents);
  if (remaining === null) return { allowed: true };
  if (customer.creditLimitCents === 0) {
    return { allowed: false, reason: 'no-credit', remainingCents: 0 };
  }
  if (amountCents > remaining) {
    return { allowed: false, reason: 'over-limit', remainingCents: remaining };
  }
  return { allowed: true };
}

/**
 * Depuis combien de jours le compte n'est pas revenu à zéro.
 *
 * C'est la seule question qui compte pour une relance : un client qui doit
 * 200 000 Ar depuis avant-hier et un qui doit 5 000 Ar depuis huit mois ne se
 * traitent pas pareil, et le montant seul ne les distingue pas.
 *
 * Renvoie `null` si le compte est soldé — il n'y a rien à relancer.
 */
export function accountAgeDays(
  movements: readonly CustomerAccountMovement[],
  now = Date.now(),
): number | null {
  const balance = accountBalance(movements);
  if (balance <= 0) return null;

  // On remonte le journal à l'envers en défaisant chaque écriture : le dernier
  // instant où le solde était nul ou négatif est la date d'origine de la dette
  // actuelle. Tout ce qui précède a été réglé.
  const ordered = [...movements].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let running = balance;
  let since = ordered[0]?.createdAt ?? null;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const movement = ordered[index];
    if (!movement) continue;
    const before = running - movement.amountCents;
    if (before <= 0) {
      since = movement.createdAt;
      break;
    }
    running = before;
    since = movement.createdAt;
  }

  if (since === null) return null;
  const days = Math.floor((now - Date.parse(since)) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

/**
 * Espèces entrées dans le tiroir au titre des ardoises, sur une session.
 *
 * Les remboursements sont des montants NÉGATIFS au compte du client ; côté
 * tiroir, ce sont des entrées. D'où le changement de signe, qui n'est pas une
 * commodité : compter un remboursement en négatif ferait apparaître un
 * manquant du montant exact que le client vient de poser sur le comptoir.
 */
export function cashCollectedOnAccounts(
  movements: readonly CustomerAccountMovement[],
  cashSessionId: string,
): Cents {
  return sumCents(
    movements
      .filter(
        (movement) =>
          movement.cashSessionId === cashSessionId &&
          movement.method === 'cash' &&
          movement.amountCents < 0,
      )
      .map((movement) => -movement.amountCents),
  );
}

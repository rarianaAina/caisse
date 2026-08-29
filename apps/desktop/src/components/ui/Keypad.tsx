interface KeypadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onValidate: () => void;
  disabled?: boolean;
  validateLabel?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Pavé numérique tactile.
 *
 * Cibles de 4,5 rem : une caisse s'utilise debout, au doigt, parfois avec des
 * gants. Le clavier physique reste utilisable en parallèle (cf. PinScreen).
 */
export function Keypad({
  onDigit,
  onBackspace,
  onValidate,
  disabled = false,
  validateLabel = 'Valider',
}: KeypadProps) {
  const buttonClass =
    'h-18 rounded-xl text-2xl font-semibold transition active:scale-95 disabled:opacity-40';

  return (
    <div className="grid grid-cols-3 gap-3">
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onDigit(key)}
          className={`${buttonClass} bg-ardoise-100 text-ardoise-900 hover:bg-ardoise-200`}
        >
          {key}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={onBackspace}
        aria-label="Effacer le dernier chiffre"
        className={`${buttonClass} bg-ardoise-100 text-ardoise-500 hover:bg-ardoise-200`}
      >
        ⌫
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDigit('0')}
        className={`${buttonClass} bg-ardoise-100 text-ardoise-900 hover:bg-ardoise-200`}
      >
        0
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onValidate}
        aria-label={validateLabel}
        className={`${buttonClass} bg-caisse-600 text-white hover:bg-caisse-700`}
      >
        ↵
      </button>
    </div>
  );
}

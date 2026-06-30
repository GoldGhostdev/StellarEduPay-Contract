'use strict';

/**
 * i18n Service
 *
 * Provides translated strings for fee reminder emails in the six locales
 * supported by StellarEduPay:
 *
 *   en  — English (default)
 *   fr  — French
 *   es  — Spanish
 *   pt  — Portuguese
 *   tpi — Tok Pisin (Papua New Guinea)
 *   ha  — Hausa (Nigeria / West Africa)
 *
 * Usage:
 *   const { t } = require('./i18n');
 *   t('fr', 'greeting')              // → 'Cher Parent/Tuteur,'
 *   t('unknown', 'greeting')         // → falls back to English
 *   t('en', 'reminderNote', { n: 3}) // → 'Note: This is reminder #3. …'
 */

const translations = {
  en: {
    greeting:        'Dear Parent/Guardian,',
    feeReminder:     'This is a reminder that school fees are outstanding.',
    school:          'School',
    feeAmount:       'Fee Amount',
    amountDue:       'Amount Due',
    payPrompt:       'Please arrange payment at your earliest convenience.',
    thanks:          'Thank you,',
    administration:  'Administration',
    unsubscribeText: 'To stop receiving these reminders:',
    reminderNote:    'Note: This is reminder #{{n}}. If you have already paid, please disregard.',
  },
  fr: {
    greeting:        'Cher Parent/Tuteur,',
    feeReminder:     'Ceci est un rappel que les frais de scolarité sont en attente.',
    school:          'École',
    feeAmount:       'Montant des frais',
    amountDue:       'Montant dû',
    payPrompt:       'Veuillez effectuer le paiement dès que possible.',
    thanks:          'Merci,',
    administration:  'Administration',
    unsubscribeText: 'Pour arrêter de recevoir ces rappels :',
    reminderNote:    'Remarque : Ceci est le rappel n°{{n}}. Si vous avez déjà payé, veuillez ignorer ce message.',
  },
  es: {
    greeting:        'Estimado Padre/Tutor,',
    feeReminder:     'Este es un recordatorio de que los aranceles escolares están pendientes.',
    school:          'Escuela',
    feeAmount:       'Importe de la tarifa',
    amountDue:       'Importe pendiente',
    payPrompt:       'Por favor, realice el pago a la mayor brevedad posible.',
    thanks:          'Gracias,',
    administration:  'Administración',
    unsubscribeText: 'Para dejar de recibir estos recordatorios:',
    reminderNote:    'Nota: Este es el recordatorio n.º {{n}}. Si ya ha pagado, por favor ignore este mensaje.',
  },
  pt: {
    greeting:        'Caro Pai/Responsável,',
    feeReminder:     'Este é um lembrete de que as propinas escolares estão pendentes.',
    school:          'Escola',
    feeAmount:       'Valor da taxa',
    amountDue:       'Valor em dívida',
    payPrompt:       'Por favor, efectue o pagamento o mais brevemente possível.',
    thanks:          'Obrigado,',
    administration:  'Administração',
    unsubscribeText: 'Para deixar de receber estes lembretes:',
    reminderNote:    'Nota: Este é o lembrete n.º {{n}}. Se já pagou, por favor ignore esta mensagem.',
  },
  tpi: {
    // Tok Pisin — Papua New Guinea
    greeting:        'Gutpela Papamama/Gaiden,',
    feeReminder:     'Dispela em wanpela kirap bilong skul mani i stap yet.',
    school:          'Skul',
    feeAmount:       'Bikpela mani bilong skul',
    amountDue:       'Mani i mas baim',
    payPrompt:       'Plis baim mani kwik taim yu inap.',
    thanks:          'Tenkyu,',
    administration:  'Administresin',
    unsubscribeText: 'Sapos yu no laik kisim sampela moa kirap:',
    reminderNote:    'Nots: Dispela em namba {{n}} kirap. Sapos yu baim pinis, plis lusim dispela tok.',
  },
  ha: {
    // Hausa — Nigeria / West Africa
    greeting:        'Masoyin Iyaye/Mai Kula,',
    feeReminder:     'Wannan tunasarwa ne cewa kuɗin makaranta har yanzu ba a biya ba.',
    school:          'Makaranta',
    feeAmount:       'Adadin kuɗin makaranta',
    amountDue:       'Adadin da ake bin bashi',
    payPrompt:       'Don Allah ka biya kuɗi da wuri-wuri.',
    thanks:          'Na gode,',
    administration:  'Gudanarwa',
    unsubscribeText: 'Don daina karɓar waɗannan tunatarwa:',
    reminderNote:    'Lura: Wannan shine tunatarwa ta {{n}}. Idan ka riga ka biya, da fatan za ka yi watsi da wannan saƙo.',
  },
};

/**
 * Return the translated string for the given locale and key.
 * If the locale is unsupported, falls back to 'en'.
 * If vars are provided, interpolates {{varName}} placeholders in the string.
 *
 * @param {string} locale   - One of: en, fr, es, pt, tpi, ha
 * @param {string} key      - Translation key
 * @param {object} vars     - Optional interpolation variables
 * @returns {string}
 */
function t(locale, key, vars = {}) {
  const dict = translations[locale] || translations.en;
  const template = dict[key] !== undefined ? dict[key] : (translations.en[key] || '');

  if (!Object.keys(vars).length) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

module.exports = { translations, t };

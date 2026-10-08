// Names of the tags and custom fields in Paperless, overridable in settings.yml
// (`paperless.bill_tag`, `paperless.field.amount`, …) for setups that use other
// names. Shared by the import and by `npm run paperless:setup`.

export const paperlessNames = {
  billTag: () => process.env.PAPERLESS_BILL_TAG?.trim() || 'bill',
  paymentTag: () => process.env.PAPERLESS_PAYMENT_TAG?.trim() || 'bill-payment',
  // Comma-separated; a document carrying any of these is not ready yet.
  pendingTags: () =>
    (process.env.PAPERLESS_PENDING_TAGS ?? 'paperless-gpt')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  amountField: () => process.env.PAPERLESS_FIELD_AMOUNT?.trim() || 'Amount',
  dueDateField: () => process.env.PAPERLESS_FIELD_DUE_DATE?.trim() || 'Due date',
  accountField: () => process.env.PAPERLESS_FIELD_ACCOUNT?.trim() || 'Account number',
  invoiceField: () => process.env.PAPERLESS_FIELD_INVOICE?.trim() || 'Invoice number',
};

// Plain serializable shapes shared between the API responses and the client.
// (Dates are ISO strings, matching JSON serialization.)

export interface CategoryDTO {
  id: string;
  name: string;
  color: string | null;
}

// Fuller shape for the category-management screen.
export interface CategoryAdminDTO {
  id: string;
  name: string;
  kind: string;
  color: string | null;
  icon: string | null;
}

export interface MemberDTO {
  id: string;
  name: string;
}

// Richer shape for the member-management screen (the lightweight MemberDTO above
// is what tasks/etc. embed as an assignee).
export interface HouseholdMemberDTO {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface RecurrenceDTO {
  kind: string;
  interval: number;
  byWeekday: string | null;
  byMonthday: string | null;
  timezone: string;
  until: string | null;
  nextRunAt: string | null;
}

export interface SubtaskDTO {
  id: string;
  title: string;
  done: boolean;
  // When the item was last checked (null when unchecked).
  doneAt: string | null;
  // Auto-uncheck cadence in days; null = resets only with the parent task.
  resetIntervalDays: number | null;
  position: number;
}

export interface TaskCompletionDTO {
  id: string;
  note: string | null;
  completedAt: string;
  user: MemberDTO | null;
}

export interface TaskDTO {
  id: string;
  title: string;
  notes: string | null;
  type: string;
  priority: string;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  estimatedMinutes: number | null;
  category: CategoryDTO | null;
  assignee: MemberDTO | null;
  recurrence: RecurrenceDTO | null;
  subtasks: SubtaskDTO[];
}

export interface ShoppingItemDTO {
  id: string;
  listId: string;
  name: string;
  quantity: number;
  priority: string;
  notes: string | null;
  url: string | null;
  imageUrl: string | null;
  estimatedPrice: number | null;
  recurring: boolean;
  purchased: boolean;
  purchasedAt: string | null;
  category: CategoryDTO | null;
}

// Best-effort Open Graph metadata pulled from a pasted product link. Any field
// may be null when the page can't be read (e.g. Amazon's bot wall) — the UI then
// falls back to manual entry.
export interface LinkPreviewDTO {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
}

export interface ShoppingListDTO {
  id: string;
  name: string;
  kind: string;
  items: ShoppingItemDTO[];
  openCount: number;
  purchasedCount: number;
}

export interface InventoryItemDTO {
  id: string;
  name: string;
  unit: string | null;
  quantity: number;
  lowThreshold: number;
  isLow: boolean;
  reorderIntervalDays: number | null;
  lastRestockedAt: string | null;
  predictedDepletionAt: string | null;
  category: CategoryDTO | null;
}

export interface NfcTagDTO {
  id: string;
  tagId: string;
  label: string;
  represents: string;
  item: { id: string; name: string } | null;
  /** Android app behaviour on scan: "open" | "notify" (NFC_SCAN_ACTIONS). */
  scanAction: string;
  /** Where "Add to shopping list" puts the item; null = first grocery list. */
  shoppingListId: string | null;
}

/** What a scanned tag resolves to (Android app lookup). */
export interface NfcLookupDTO {
  tagId: string;
  /** Null when the tag isn't set up yet. */
  tag: NfcTagDTO | null;
  /** The bound item, or null (unknown tag, or a tag bound to nothing). */
  item: InventoryItemDTO | null;
}

/** One entry of the scan history (EventLog nfc_scan / nfc_register). */
export interface NfcScanDTO {
  id: string;
  kind: 'scan' | 'register';
  tagId: string;
  itemId: string | null;
  itemName: string | null;
  /** Signed delta applied; null for a setup that set no quantity change. */
  amount: number | null;
  resultQuantity: number | null;
  /** "home_assistant" (HA webhook) or "nfc" (Android app). */
  source: string;
  actorName: string | null;
  createdAt: string;
}

export interface IntegrationDTO {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

// One occurrence of a calendar event (recurring events expand into several).
// baseStart/baseEnd describe the underlying event so the edit form can prefill.
export interface EventOccurrenceDTO {
  eventId: string;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: string;
  end: string | null;
  baseStart: string;
  baseEnd: string | null;
  recurring: boolean;
  recurrence: RecurrenceDTO | null;
  attendees: MemberDTO[];
}

export interface BillDTO {
  id: string;
  name: string;
  amount: number;
  currentCharges: number | null;
  currency: string | null;
  dueDate: string | null;
  status: string;
  category: string | null;
  autoPay: boolean;
  notes: string | null;
  source: string;
  // Cross-document link key (invoice # > confirmation # > generated) for
  // email-ingested bills; null for manually entered ones.
  reference: string | null;
  recurrence: RecurrenceDTO | null;
  assignee: MemberDTO | null;
  // Aggregates over the bill's BillPayment records (fees excluded — `amount` is
  // the portion applied to the balance). Drive list progress + "partially paid".
  paidTotal: number;
  paymentCount: number;
}

export interface BillPaymentDTO {
  id: string;
  billId: string | null;
  // Portion applied to the bill's balance; `fee` is any card surcharge on top.
  amount: number;
  fee: number | null;
  paidAt: string;
  notes: string | null;
  source: string;
  confirmationNo: string | null;
  paidBy: MemberDTO | null;
}

// A bill plus everything the detail page shows: the email-linkage fields the
// list DTO omits, the full payment history, and derived totals.
export interface BillDetailDTO extends BillDTO {
  invoiceNo: string | null;
  accountNo: string | null;
  confirmationNo: string | null;
  billerEmail: string | null;
  /** The original document (Paperless), for "Open in Paperless". */
  sourceUrl: string | null;
  feeTotal: number;
  remaining: number;
  payments: BillPaymentDTO[];
}

// Paperless bill import status (paperlessSync), for the Settings card.
export interface PaperlessSkippedDTO {
  id: number;
  title: string;
  reason: string;
  /** Link to the document in Paperless, when PAPERLESS_PUBLIC_URL is set. */
  url: string | null;
}

export interface PaperlessSyncResultDTO {
  checked: number;
  /** Count per importer outcome: created / updated / linked / duplicate / skipped. */
  imported: Partial<Record<'created' | 'updated' | 'linked' | 'duplicate' | 'skipped', number>>;
  /** Recent skipped documents, newest first (kept across runs). */
  skipped: PaperlessSkippedDTO[];
}

export interface PaperlessStatusDTO {
  configured: boolean;
  /** When the import was switched on; nothing older is imported. */
  since: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastResult: PaperlessSyncResultDTO | null;
}

// A stored contact-form submission (global, not household-scoped).
// status: "received" | "emailed" | "email_failed" — see contactService.
export interface ContactMessageDTO {
  id: string;
  name: string;
  email: string;
  description: string;
  status: string;
  createdAt: string;
}

export interface RequestDTO {
  id: string;
  category: string;
  title: string;
  // media
  mediaType: string | null;
  year: number | null;
  season: number | null;
  // maintenance
  details: string | null;
  assignee: MemberDTO | null;
  status: string | null;
  /** Done-by date the assignee committed to (the deadline). */
  dueAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  requester: MemberDTO;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  subjectType: string | null;
  subjectId: string | null;
  read: boolean;
  createdAt: string;
}

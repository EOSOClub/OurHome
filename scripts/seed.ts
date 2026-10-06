import 'dotenv/config';
import { createHash } from 'node:crypto';
import { prisma } from '@/server/db/prisma';
import { auth } from '@/server/auth/auth';
import { createTask } from '@/server/services/taskService';
import {
  addShoppingItem,
  createShoppingList,
} from '@/server/services/shoppingService';
import { createInventoryItem } from '@/server/services/inventoryService';
import { registerNfcTag } from '@/server/services/nfcService';
import type { CreateTaskInput } from '@/lib/validation/task';
import type { AddShoppingItemInput } from '@/lib/validation/shopping';

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

async function ensureUser(
  email: string,
  password: string,
  name: string,
  username: string,
  { capitalizeDisplayUsername = false }: { capitalizeDisplayUsername?: boolean } = {},
) {
  const trimmed = username.trim();
  const displayUsername = capitalizeDisplayUsername ? capitalize(trimmed) : trimmed;
  const normalizedUsername = trimmed.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Re-apply the username on every seed so existing accounts pick up changes
    // (e.g. displayUsername capitalization), not just first-time backfills.
    return prisma.user.update({
      where: { id: existing.id },
      data: { username: normalizedUsername, displayUsername },
    });
  }

  // Public sign-up is disabled (auth.ts), so auth.api.signUpEmail would now be
  // rejected. Create the user + credential account directly, hashing the
  // password with Better Auth's configured algorithm — same path the Members UI
  // uses (see createMember in src/server/services/userService.ts).
  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(password);

  return prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase(),
        emailVerified: false,
        username: normalizedUsername,
        displayUsername,
      },
    });
    await tx.account.create({
      data: {
        accountId: created.id,
        providerId: 'credential',
        userId: created.id,
        password: hashed,
      },
    });
    return created;
  });
}

async function ensureCategory(
  householdId: string,
  name: string,
  kind: string,
  color: string,
) {
  return prisma.category.upsert({
    where: { householdId_name_kind: { householdId, name, kind } },
    update: {},
    create: { householdId, name, kind, color },
  });
}

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'changeme-admin-123';
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  const memberEmail = process.env.SEED_MEMBER_EMAIL ?? 'member@example.local';
  const memberPassword =
    process.env.SEED_MEMBER_PASSWORD ?? 'changeme-member-123';
  const memberUsername = process.env.SEED_MEMBER_USERNAME ?? 'member';
  const adminName = process.env.SEED_ADMIN_NAME ?? 'Admin';
  // The household is found by name, so keep this stable once seeded — changing
  // it later would create a second household on the next seed.
  const householdName = process.env.SEED_HOUSEHOLD_NAME ?? 'Our Home';

  // 1. Household
  let household = await prisma.household.findFirst({
    where: { name: householdName },
  });
  household ??= await prisma.household.create({
    data: { name: householdName },
  });

  // 2. Users (created via Better Auth, then assigned role + household)
  const admin = await ensureUser(adminEmail, adminPassword, adminName, adminUsername);
  const member = await ensureUser(
    memberEmail,
    memberPassword,
    'Partner',
    memberUsername,
    { capitalizeDisplayUsername: true },
  );

  await prisma.user.update({
    where: { id: admin.id },
    data: { role: 'head', householdId: household.id },
  });
  await prisma.user.update({
    where: { id: member.id },
    data: { role: 'member', householdId: household.id },
  });

  // 3. Categories
  const cleaning = await ensureCategory(household.id, 'Cleaning', 'task', '#38bdf8');
  const pets = await ensureCategory(household.id, 'Pets', 'task', '#f472b6');
  const maintenance = await ensureCategory(
    household.id,
    'Maintenance',
    'task',
    '#fbbf24',
  );
  const yard = await ensureCategory(household.id, 'Yard', 'task', '#34d399');
  const groceryCat = await ensureCategory(
    household.id,
    'Grocery',
    'shopping',
    '#a78bfa',
  );
  const suppliesCat = await ensureCategory(
    household.id,
    'Supplies',
    'shopping',
    '#f87171',
  );

  // 4. Sample tasks (only if the household has none yet)
  const existingTasks = await prisma.task.count({
    where: { householdId: household.id },
  });

  if (existingTasks === 0) {
    const seeds: CreateTaskInput[] = [
      {
        title: 'Take trash out',
        type: 'recurring',
        priority: 'high',
        // Yesterday -> shows up as overdue on the dashboard.
        dueDate: daysFromNow(-1),
        categoryId: cleaning.id,
        assigneeId: admin.id,
        recurrence: { kind: 'weekly', interval: 1, byWeekday: [1], timezone: 'UTC' },
      },
      {
        title: 'Clean litter box',
        type: 'recurring',
        priority: 'medium',
        dueDate: daysFromNow(1),
        categoryId: pets.id,
        assigneeId: member.id,
        recurrence: { kind: 'interval', interval: 2, timezone: 'UTC' },
      },
      {
        title: 'Replace furnace filter',
        type: 'maintenance',
        priority: 'medium',
        dueDate: daysFromNow(20),
        categoryId: maintenance.id,
        assigneeId: admin.id,
        recurrence: { kind: 'monthly', interval: 3, timezone: 'UTC' },
      },
      {
        title: 'Mow the lawn',
        type: 'recurring',
        priority: 'medium',
        dueDate: daysFromNow(3),
        categoryId: yard.id,
        recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
      },
      {
        title: 'Hang pictures in hallway',
        type: 'one_time',
        priority: 'low',
        dueDate: daysFromNow(5),
      },
    ];

    for (const seed of seeds) {
      await createTask(household.id, admin.id, seed);
    }
  }

  // 5. Sample shopping lists & items (only if the household has none yet)
  const existingLists = await prisma.shoppingList.count({
    where: { householdId: household.id },
  });

  if (existingLists === 0) {
    const groceries = await createShoppingList(household.id, admin.id, {
      name: 'Weekly groceries',
      kind: 'grocery',
    });
    const supplies = await createShoppingList(household.id, admin.id, {
      name: 'Household supplies',
      kind: 'supplies',
    });

    const items: AddShoppingItemInput[] = [
      { listId: groceries.id, name: 'Milk', quantity: 2, priority: 'high', recurring: true, categoryId: groceryCat.id, estimatedPrice: 3.49 },
      { listId: groceries.id, name: 'Eggs', quantity: 1, priority: 'medium', recurring: true, categoryId: groceryCat.id },
      { listId: groceries.id, name: 'Coffee beans', quantity: 1, priority: 'medium', recurring: false, categoryId: groceryCat.id, estimatedPrice: 12.0 },
      { listId: supplies.id, name: 'Paper towels', quantity: 1, priority: 'medium', recurring: true, categoryId: suppliesCat.id },
      { listId: supplies.id, name: 'Trash bags', quantity: 1, priority: 'high', recurring: true, categoryId: suppliesCat.id, estimatedPrice: 9.99 },
    ];

    for (const item of items) {
      await addShoppingItem(household.id, admin.id, item);
    }
  }

  // 6. Sample inventory + an NFC tag mapping (only if the household has none yet)
  const existingInventory = await prisma.inventoryItem.count({
    where: { householdId: household.id },
  });

  if (existingInventory === 0) {
    const pantryCat = await ensureCategory(
      household.id,
      'Pantry',
      'inventory',
      '#fb923c',
    );

    const coffee = await createInventoryItem(household.id, admin.id, {
      name: 'Coffee beans',
      unit: 'bags',
      quantity: 2,
      lowThreshold: 1,
      reorderIntervalDays: 21,
      categoryId: pantryCat.id,
    });
    // Starts low (1 <= 2) so the low-stock UI is visible after seeding.
    await createInventoryItem(household.id, admin.id, {
      name: 'Paper towels',
      unit: 'rolls',
      quantity: 1,
      lowThreshold: 2,
    });
    await createInventoryItem(household.id, admin.id, {
      name: 'Dish soap',
      unit: 'bottles',
      quantity: 3,
      lowThreshold: 1,
    });

    await registerNfcTag(household.id, admin.id, {
      tagId: 'pantry_coffee',
      label: 'Coffee shelf',
      itemId: coffee.id,
      represents: 'consumable',
    });
  }

  // 7. Home Assistant webhook token (dev). Uses a known token so the webhook
  // can be exercised locally; override with SEED_HA_TOKEN.
  const haToken = process.env.SEED_HA_TOKEN ?? 'dev-ha-token-change-me';
  const haTokenHash = createHash('sha256').update(haToken).digest('hex');
  const existingIntegration = await prisma.homeAssistantIntegration.findFirst({
    where: { householdId: household.id, tokenHash: haTokenHash },
  });
  if (!existingIntegration) {
    await prisma.homeAssistantIntegration.create({
      data: {
        householdId: household.id,
        name: 'Home Assistant (dev)',
        tokenHash: haTokenHash,
        active: true,
      },
    });
  }

  console.log(
    `Seed complete: household "${household.name}" with ${admin.email} (Head of House) and ${member.email} (member).`,
  );
  console.log(`Dev Home Assistant webhook token: ${haToken}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
